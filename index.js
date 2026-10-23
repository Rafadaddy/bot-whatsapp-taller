import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import express from 'express';

const require = createRequire(import.meta.url);
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, onSnapshot, query, where, doc, getDoc, setDoc, deleteDoc } = require('firebase/firestore');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// 1. Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyCIE43xfxq495ccdHPRwtTl0CsE92SS80k",
  authDomain: "base44-estatus.firebaseapp.com",
  projectId: "base44-estatus",
  storageBucket: "base44-estatus.firebasestorage.app",
  messagingSenderId: "1024236008658",
  appId: "1:1024236008658:web:409c974ce6238b6b98e90b",
  measurementId: "G-MW7P2F22RJ"
};

const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

// Estado en memoria
const BOT_START_TIMESTAMP = Date.now();
let botActivo = true;
let estadoConexion = 'iniciando'; // 'iniciando', 'esperando_qr', 'conectado', 'desconectado'
let ultimoQRDataURL = null;
let gruposDetectados = [];
let socketWhatsApp = null;
let listenerIniciado = false;
const estadosConocidos = new Map();

// Leer y guardar configuración
function leerConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error al leer config.json:', err.message);
  }
  return { grupoIngresosId: '', grupoListasId: '' };
}

function guardarConfig(nuevaConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2));
  } catch (err) {
    console.error('Error al guardar config.json:', err.message);
  }
}

let config = leerConfig();

// --- PERSISTENCIA DE SESIÓN EN FIREBASE ---
async function restaurarSesionDesdeFirebase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const snap = await getDoc(doc(firestore, '_system', 'whatsapp_session'));
    if (snap.exists()) {
      const data = snap.data();
      if (data && data.files && Object.keys(data.files).length > 0) {
        console.log('🔄 Restaurando sesión de WhatsApp guardada en la nube...');
        for (const [filename, content] of Object.entries(data.files)) {
          fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf-8');
        }
        console.log('✅ Sesión restaurada con éxito.');
        return true;
      }
    }
  } catch (e) {
    console.warn('No se pudo restaurar sesión de Firebase:', e.message);
  }
  return false;
}

async function respaldarSesionAFirebase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const fileList = fs.readdirSync(AUTH_DIR);
    const files = {};
    for (const f of fileList) {
      const fullPath = path.join(AUTH_DIR, f);
      if (fs.statSync(fullPath).isFile()) {
        files[f] = fs.readFileSync(fullPath, 'utf-8');
      }
    }
    await setDoc(doc(firestore, '_system', 'whatsapp_session'), {
      files,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('Error al respaldar sesión en Firebase:', e.message);
  }
}

async function limpiarSesionFirebase() {
  try {
    await deleteDoc(doc(firestore, '_system', 'whatsapp_session'));
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('Error al limpiar sesión:', e.message);
  }
}

// 2. Conexión de WhatsApp
async function iniciarWhatsApp() {
  estadoConexion = 'iniciando';
  console.log('⏳ Iniciando conexión de WhatsApp...');
  await restaurarSesionDesdeFirebase();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  socketWhatsApp = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  socketWhatsApp.ev.on('creds.update', async () => {
    await saveCreds();
    await respaldarSesionAFirebase();
  });

  socketWhatsApp.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      estadoConexion = 'esperando_qr';
      ultimoQRDataURL = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
      console.log('📱 ¡Código QR generado con éxito! Visible en la página web.');
      try { qrcodeTerminal.generate(qr, { small: true }); } catch (e) {}
    }

    if (connection === 'open') {
      estadoConexion = 'conectado';
      ultimoQRDataURL = null;
      console.log('✅ ¡WHATSAPP CONECTADO EXITOSAMENTE A LA NUBE!');
      await respaldarSesionAFirebase();

      try {
        const grupos = await socketWhatsApp.groupFetchAllParticipating();
        gruposDetectados = Object.values(grupos).map(g => ({
          id: g.id,
          name: g.subject
        }));
        console.log(`📋 ${gruposDetectados.length} grupos detectados.`);
      } catch (e) {
        console.warn('Error al obtener grupos:', e.message);
      }

      if (!listenerIniciado) {
        iniciarListenerFirebase();
        listenerIniciado = true;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const debeReconectar = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Conexión de WhatsApp cerrada (Código: ${statusCode}). Reconectando: ${debeReconectar}`);
      
      if (debeReconectar) {
        estadoConexion = 'iniciando';
        setTimeout(iniciarWhatsApp, 3000);
      } else {
        estadoConexion = 'desconectado';
        console.log('❌ Sesión cerrada permanentemente.');
        await limpiarSesionFirebase();
        setTimeout(iniciarWhatsApp, 2000);
      }
    }
  });
}

// Enviar mensajes a WhatsApp
async function enviarMensajeGrupo(grupoId, texto) {
  if (!botActivo) {
    console.log(`⏸️ [PAUSADO] El bot está en pausa. Mensaje no enviado: "${texto}"`);
    return;
  }
  if (!socketWhatsApp || estadoConexion !== 'conectado') {
    console.warn(`[!] No se pudo enviar mensaje porque WhatsApp no está conectado.`);
    return;
  }
  if (!grupoId || grupoId.trim() === '') {
    console.warn(`[!] Falta configurar el ID del grupo en la página de control.`);
    return;
  }

  try {
    await socketWhatsApp.sendMessage(grupoId, { text: texto });
    console.log(`📨 [${new Date().toLocaleTimeString('es-MX')}] Enviado a ${grupoId}: "${texto}"`);
  } catch (error) {
    console.error(`❌ Error al enviar mensaje:`, error.message);
  }
}

// 3. Listener en tiempo real de Firebase
function iniciarListenerFirebase() {
  console.log('📡 Conectando a la base de datos de unidades en vivo...');
  let esCargaInicial = true;
  const q = query(collection(firestore, 'units'), where('status', '!=', 'entregada'));

  onSnapshot(q, (snapshot) => {
    if (esCargaInicial) {
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data();
        estadosConocidos.set(docSnap.id, {
          status: data.status,
          unit_number: data.unit_number
        });
      });
      esCargaInicial = false;
      console.log(`⚡ Sincronización inicial: ${estadosConocidos.size} unidades registradas.`);
      return;
    }

    const changes = snapshot.docChanges();
    changes.forEach(async (change) => {
      const docId = change.doc.id;
      const unit = change.doc.data();
      const numUnidad = unit.unit_number || 'S/N';
      config = leerConfig();

      // NUEVA UNIDAD
      if (change.type === 'added') {
        const yaExiste = estadosConocidos.has(docId);
        estadosConocidos.set(docId, {
          status: unit.status,
          unit_number: numUnidad
        });

        if (!yaExiste) {
          const fechaCreacion = unit.created_date ? new Date(unit.created_date).getTime() : Date.now();
          if (fechaCreacion >= (BOT_START_TIMESTAMP - 30000)) {
            let fallasTexto = '';
            if (Array.isArray(unit.faults) && unit.faults.length > 0) {
              const listaFallas = unit.faults
                .map(f => typeof f === 'string' ? f : (f.description || f.cause || ''))
                .filter(Boolean);
              if (listaFallas.length > 0) {
                fallasTexto = ' ' + listaFallas.join(' // ');
              }
            } else if (unit.reported_fault) {
              fallasTexto = ' ' + unit.reported_fault;
            }

            const mensaje = `*${numUnidad}*${fallasTexto}`;
            console.log(`\n🆕 [NUEVA UNIDAD] Enviando al grupo...`);
            await enviarMensajeGrupo(config.grupoIngresosId, mensaje);
          }
        }
      }

      // CAMBIO DE ESTATUS
      if (change.type === 'modified') {
        const previo = estadosConocidos.get(docId) || {};
        const estatusAnterior = previo.status;
        const estatusActual = unit.status;

        estadosConocidos.set(docId, {
          status: estatusActual,
          unit_number: numUnidad
        });

        if (estatusActual === 'lista' && estatusAnterior !== 'lista') {
          const mensaje = `${numUnidad} lista`;
          console.log(`\n🎉 [UNIDAD LISTA] Unidad #${numUnidad} lista.`);
          await enviarMensajeGrupo(config.grupoListasId, mensaje);
        }
      }

      if (change.type === 'removed') {
        estadosConocidos.delete(docId);
      }
    });
  }, (error) => {
    console.error('Error en listener de Firebase:', error.message);
  });
}

// 4. Servidor Web Express (Panel de Control)
const server = express();
server.use(express.json());
server.use(express.urlencoded({ extended: true }));

server.get('/', (req, res) => {
  config = leerConfig();
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel Bot WhatsApp - Taller Base44</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .card { background: #1e293b; border-radius: 16px; padding: 20px; max-width: 520px; margin: 0 auto 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); border: 1px solid #334155; }
    h1 { font-size: 18px; margin: 0 0 16px 0; display: flex; align-items: center; justify-content: space-between; }
    .badge { font-size: 12px; padding: 6px 12px; border-radius: 20px; font-weight: bold; }
    .badge-conectado { background: #059669; color: #fff; }
    .badge-qr { background: #d97706; color: #fff; animation: pulse 1.5s infinite; }
    .badge-iniciando { background: #6366f1; color: #fff; }
    .badge-desconectado { background: #dc2626; color: #fff; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    .qr-container { text-align: center; margin: 16px 0; background: #fff; padding: 16px; border-radius: 12px; }
    .qr-container img { max-width: 260px; width: 100%; height: auto; }
    .btn { display: inline-block; width: 100%; padding: 12px; font-size: 14px; font-weight: bold; border-radius: 8px; border: none; cursor: pointer; text-align: center; box-sizing: border-box; text-decoration: none; margin-top: 8px; }
    .btn-toggle-on { background: #10b981; color: white; }
    .btn-toggle-off { background: #64748b; color: white; }
    .btn-save { background: #3b82f6; color: white; }
    .btn-danger { background: #ef4444; color: white; }
    .btn-assign { padding: 6px 10px; font-size: 11px; font-weight: bold; border-radius: 6px; border: none; cursor: pointer; color: white; }
    .btn-blue { background: #2563eb; }
    .btn-green { background: #059669; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; font-weight: 600; }
    input[type="text"] { width: 100%; padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 13px; box-sizing: border-box; }
    .group-item { background: #0f172a; padding: 12px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #1e293b; }
    .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .group-name { font-weight: bold; font-size: 14px; color: #f1f5f9; }
    .group-id { color: #38bdf8; font-family: monospace; font-size: 11px; word-break: break-all; }
    .group-actions { display: flex; gap: 8px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>
      <span>🤖 Bot Taller Base44</span>
      <span class="badge ${
        estadoConexion === 'conectado' ? 'badge-conectado' : 
        (estadoConexion === 'esperando_qr' ? 'badge-qr' : 
        (estadoConexion === 'iniciando' ? 'badge-iniciando' : 'badge-desconectado'))
      }">
        ${
          estadoConexion === 'conectado' ? '● Conectado' : 
          (estadoConexion === 'esperando_qr' ? '● Escanear QR' : 
          (estadoConexion === 'iniciando' ? '● Iniciando...' : '● Reconectando...'))
        }
      </span>
    </h1>

    <div style="margin: 14px 0;">
      <label>ESTADO DEL SERVICIO:</label>
      <form action="/toggle" method="POST">
        <button type="submit" class="btn ${botActivo ? 'btn-toggle-on' : 'btn-toggle-off'}">
          ${botActivo ? '🟢 BOT ACTIVO (Toca para pausar)' : '⏸️ BOT EN PAUSA (Toca para activar)'}
        </button>
      </form>
    </div>

    ${estadoConexion === 'esperando_qr' && ultimoQRDataURL ? `
      <div class="qr-container">
        <p style="color: #0f172a; font-weight: bold; margin-top: 0; font-size: 14px;">Escanea este código con tu WhatsApp:</p>
        <img src="${ultimoQRDataURL}" alt="Código QR WhatsApp" />
        <p style="color: #64748b; font-size: 11px; margin-bottom: 0;">WhatsApp > 3 puntitos > Dispositivos vinculados</p>
      </div>
    ` : ''}

    ${estadoConexion === 'iniciando' || (estadoConexion !== 'conectado' && !ultimoQRDataURL) ? `
      <div style="text-align: center; padding: 20px 10px; background: #0f172a; border-radius: 12px; margin: 16px 0;">
        <p style="margin: 0; font-size: 14px; color: #cbd5e1;">⏳ Conectando con WhatsApp...</p>
        <p style="margin: 6px 0 0 0; font-size: 12px; color: #64748b;">La página se actualizará sola cuando aparezca el código QR.</p>
      </div>
    ` : ''}

    ${estadoConexion === 'conectado' ? `
      <p style="color: #10b981; font-size: 13px; text-align: center; margin: 10px 0;">✅ WhatsApp vinculado y listo para enviar mensajes.</p>
      <form action="/logout" method="POST" onsubmit="return confirm('¿Seguro que deseas desvincular el celular?');">
        <button type="submit" class="btn btn-danger">Desvincular WhatsApp / Cambiar Celular</button>
      </form>
    ` : ''}
  </div>

  <div class="card">
    <h2 style="font-size: 16px; margin-top: 0;">🎯 Grupos Asignados</h2>
    <form action="/guardar-config" method="POST">
      <div class="form-group">
        <label>Grupo Tráfico (Nuevas Unidades):</label>
        <input type="text" id="inputIngresos" name="grupoIngresosId" value="${config.grupoIngresosId || ''}" placeholder="ID de Mecánicos Teziutlan" />
      </div>
      <div class="form-group">
        <label>Grupo Listas (Unidades terminadas):</label>
        <input type="text" id="inputListas" name="grupoListasId" value="${config.grupoListasId || ''}" placeholder="ID de Unidades listas" />
      </div>
      <button type="submit" class="btn btn-save">Guardar Grupos</button>
    </form>
  </div>

  ${gruposDetectados.length > 0 ? `
    <div class="card">
      <h2 style="font-size: 15px; margin-top: 0;">📋 Tus Grupos de WhatsApp:</h2>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 0;">Toca el botón azul o verde para asignar el grupo directamente:</p>
      ${gruposDetectados.map(g => `
        <div class="group-item">
          <div class="group-header">
            <span class="group-name">${g.name}</span>
          </div>
          <div class="group-id">${g.id}</div>
          <div class="group-actions">
            <button type="button" class="btn-assign btn-blue" onclick="asignarIngresos('${g.id}')">Usar para Nuevas</button>
            <button type="button" class="btn-assign btn-green" onclick="asignarListas('${g.id}')">Usar para Listas</button>
          </div>
        </div>
      `).join('')}
    </div>
  ` : ''}

  <script>
    function asignarIngresos(id) {
      document.getElementById('inputIngresos').value = id;
      alert('Asignado para Nuevas Unidades. Haz clic en \"Guardar Grupos\" para confirmar.');
    }
    function asignarListas(id) {
      document.getElementById('inputListas').value = id;
      alert('Asignado para Unidades Listas. Haz clic en \"Guardar Grupos\" para confirmar.');
    }
    ${estadoConexion !== 'conectado' ? `
      // Auto-recargar cada 4 segundos mientras no esté conectado para mostrar el QR
      setTimeout(() => location.reload(), 4000);
    ` : ''}
  </script>
</body>
</html>
  `);
});

server.post('/toggle', (req, res) => {
  botActivo = !botActivo;
  res.redirect('/');
});

server.post('/guardar-config', (req, res) => {
  const { grupoIngresosId, grupoListasId } = req.body;
  config = {
    ...config,
    grupoIngresosId: (grupoIngresosId || '').trim(),
    grupoListasId: (grupoListasId || '').trim()
  };
  guardarConfig(config);
  res.redirect('/');
});

server.post('/logout', async (req, res) => {
  if (socketWhatsApp) {
    try { await socketWhatsApp.logout(); } catch (e) {}
  }
  await limpiarSesionFirebase();
  setTimeout(iniciarWhatsApp, 1500);
  res.redirect('/');
});

server.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Servidor Web activo en el puerto ${PORT}`);
  iniciarWhatsApp();
});
