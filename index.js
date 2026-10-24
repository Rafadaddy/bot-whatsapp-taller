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
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, onSnapshot, query, where, doc, getDoc, getDocs, orderBy, limit, setDoc, deleteDoc } = require('firebase/firestore');

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
const auth = getAuth(app);
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
let notifiedSet = new Set();
let historialActividad = [];
const MAX_HISTORIAL = 20;
let ultimaUnidadIngreso = { numero: '5599', mensaje: '*5599* CHECAR BANDA (RECHINA)' };
let ultimaUnidadLista = { numero: '3608', mensaje: '3608 lista' };

function registrarActividad(tipo, detalle, ok = true) {
  const hora = new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: false });
  historialActividad.unshift({ hora, tipo, detalle, ok });
  if (historialActividad.length > MAX_HISTORIAL) {
    historialActividad.pop();
  }
}

// Leer y guardar configuración local
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

function guardarConfigLocal(nuevaConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2));
  } catch (err) {
    console.error('Error al guardar config.json:', err.message);
  }
}

let config = leerConfig();

// --- PERSISTENCIA EN FIREBASE ---
async function autenticarFirebase() {
  try {
    await signInWithEmailAndPassword(auth, 'bot@taller.local', 'BotPasswordTaller2026!');
    console.log('🔐 Sesión de Firebase iniciada correctamente.');
  } catch (e) {
    console.error('❌ Error al iniciar sesión en Firebase:', e.message);
  }
}

async function restaurarConfigDesdeFirebase() {
  try {
    const snap = await getDoc(doc(firestore, '_system', 'whatsapp_config'));
    if (snap.exists()) {
      const data = snap.data();
      config = {
        grupoIngresosId: data.grupoIngresosId || config.grupoIngresosId || '',
        grupoListasId: data.grupoListasId || config.grupoListasId || ''
      };
      guardarConfigLocal(config);
      console.log('🎯 Configuración de grupos restaurada desde la nube:', config);
    }
  } catch (e) {
    console.warn('No se pudo restaurar config desde Firebase:', e.message);
  }
}

async function guardarConfigEnFirebase(nuevaConfig) {
  try {
    await setDoc(doc(firestore, '_system', 'whatsapp_config'), nuevaConfig);
    console.log('💾 Grupos guardados permanentemente en Firebase.');
  } catch (e) {
    console.warn('Error al guardar config en Firebase:', e.message);
  }
}

async function cargarNotificadosDesdeFirebase() {
  try {
    const snap = await getDoc(doc(firestore, '_system', 'whatsapp_notified'));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.items)) {
        notifiedSet = new Set(data.items);
        console.log(`📋 ${notifiedSet.size} notificaciones previas recordadas desde la nube.`);
      }
    }
  } catch (e) {
    console.warn('No se pudo cargar whatsapp_notified:', e.message);
  }
}

async function guardarNotificadoEnFirebase(clave) {
  notifiedSet.add(clave);
  try {
    const items = Array.from(notifiedSet).slice(-500);
    await setDoc(doc(firestore, '_system', 'whatsapp_notified'), {
      items,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('Error al guardar notificado en Firebase:', e.message);
  }
}

async function restaurarSesionDesdeFirebase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const snap = await getDoc(doc(firestore, '_system', 'whatsapp_session'));
    if (snap.exists()) {
      const data = snap.data();
      if (data && data.files && Object.keys(data.files).length > 0) {
        console.log(`🔄 Restaurando sesión de WhatsApp guardada en la nube (${Object.keys(data.files).length} archivos)...`);
        for (const [filename, base64Content] of Object.entries(data.files)) {
          fs.writeFileSync(path.join(AUTH_DIR, filename), Buffer.from(base64Content, 'base64'));
        }
        console.log('✅ ¡Sesión de WhatsApp restaurada con éxito!');
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
        files[f] = fs.readFileSync(fullPath).toString('base64');
      }
    }
    if (Object.keys(files).length > 0) {
      await setDoc(doc(firestore, '_system', 'whatsapp_session'), {
        files,
        updated_at: new Date().toISOString()
      });
      console.log(`💾 Sesión respaldada en Firebase (${Object.keys(files).length} archivos).`);
    }
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
    console.log('🗑️ Sesión borrada de la nube y del disco.');
  } catch (e) {
    console.warn('Error al limpiar sesión:', e.message);
  }
}

// Función para obtener grupos de WhatsApp
async function actualizarGrupos() {
  if (!socketWhatsApp || estadoConexion !== 'conectado') return;
  try {
    console.log('🔄 Sincronizando grupos de WhatsApp...');
    const grupos = await socketWhatsApp.groupFetchAllParticipating();
    gruposDetectados = Object.values(grupos).map(g => ({
      id: g.id,
      name: g.subject
    }));
    console.log(`📋 ¡${gruposDetectados.length} grupos detectados con éxito!`);
  } catch (e) {
    console.warn('Reintentando sincronizar grupos...', e.message);
  }
}

// 2. Conexión de WhatsApp
const mensajeStore = new Map();

async function iniciarWhatsApp() {
  estadoConexion = 'iniciando';
  console.log('⏳ Iniciando WhatsApp Baileys...');
  
  await restaurarSesionDesdeFirebase();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  socketWhatsApp = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 30000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      if (key && key.id && mensajeStore.has(key.id)) {
        return mensajeStore.get(key.id);
      }
      return { conversation: '' };
    }
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
      console.log('📱 ¡Código QR generado con éxito!');
      try { qrcodeTerminal.generate(qr, { small: true }); } catch (e) {}
    }

    if (connection === 'open') {
      estadoConexion = 'conectado';
      ultimoQRDataURL = null;
      console.log('✅ ¡WHATSAPP CONECTADO EXITOSAMENTE!');
      await respaldarSesionAFirebase();

      // Esperar 5 segundos a que el handshake y la sincronización se estabilicen
      setTimeout(actualizarGrupos, 5000);

      if (!listenerIniciado) {
        setTimeout(() => {
          if (!listenerIniciado && estadoConexion === 'conectado') {
            iniciarListenerFirebase();
            listenerIniciado = true;
          }
        }, 5000);
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

  socketWhatsApp.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.update?.status >= 2) {
        console.log(`📬 Mensaje confirmado por WhatsApp (Status ${update.update.status}): ${update.key.id}`);
      }
    }
  });
}

// Enviar mensajes a WhatsApp
async function enviarMensajeGrupo(grupoId, texto) {
  if (!botActivo) {
    console.log(`⏸️ [PAUSADO] El bot está en pausa. Mensaje no enviado: "${texto}"`);
    registrarActividad('pausa', `Bot pausado: ${texto}`, false);
    return false;
  }
  if (!socketWhatsApp || estadoConexion !== 'conectado') {
    console.warn(`[!] No se pudo enviar mensaje porque WhatsApp no está conectado.`);
    registrarActividad('error', `WhatsApp desconectado: ${texto}`, false);
    return false;
  }
  if (!grupoId || grupoId.trim() === '') {
    console.warn(`[!] Falta configurar el ID del grupo en la página de control.`);
    registrarActividad('error', `Sin grupo asignado: ${texto}`, false);
    return false;
  }

  try {
    const res = await socketWhatsApp.sendMessage(grupoId, { text: texto });
    if (res && res.key && res.key.id) {
      mensajeStore.set(res.key.id, res.message);
      if (mensajeStore.size > 200) {
        const firstKey = mensajeStore.keys().next().value;
        mensajeStore.delete(firstKey);
      }
    }
    console.log(`📨 [${new Date().toLocaleTimeString('es-MX')}] Enviado a ${grupoId}: "${texto}"`);
    registrarActividad('envio', texto, true);
    return true;
  } catch (error) {
    console.error(`❌ Error al enviar mensaje:`, error.message);
    registrarActividad('error', `Error al enviar: ${error.message}`, false);
    return false;
  }
}

function construirMensajeIngreso(unit, numUnidad) {
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
  return `*${numUnidad}*${fallasTexto}`;
}

async function notificarIngresoSiAplica(docId, unit) {
  const clave = docId + '_ingreso';
  if (notifiedSet.has(clave)) return false;

  const numUnidad = unit.unit_number || 'S/N';
  const mensaje = construirMensajeIngreso(unit, numUnidad);
  ultimaUnidadIngreso = { numero: numUnidad, mensaje };
  console.log(`\n🆕 [NUEVA UNIDAD] #${numUnidad} -> Enviando a WhatsApp...`);
  config = leerConfig();
  const ok = await enviarMensajeGrupo(config.grupoIngresosId, mensaje);
  if (ok) {
    await guardarNotificadoEnFirebase(clave);
    return true;
  }
  return false;
}

async function notificarListaSiAplica(docId, unit) {
  const clave = docId + '_lista';
  if (notifiedSet.has(clave)) return false;

  const numUnidad = unit.unit_number || 'S/N';
  const mensaje = `${numUnidad} lista`;
  ultimaUnidadLista = { numero: numUnidad, mensaje };
  console.log(`\n🎉 [UNIDAD LISTA] #${numUnidad} lista -> Enviando a WhatsApp...`);
  config = leerConfig();
  const ok = await enviarMensajeGrupo(config.grupoListasId, mensaje);
  if (ok) {
    await guardarNotificadoEnFirebase(clave);
    return true;
  }
  return false;
}

// 3. Listener en tiempo real de Firebase
function iniciarListenerFirebase() {
  console.log('📡 Conectando a la base de datos de unidades en vivo...');
  let esCargaInicial = true;
  const q = query(collection(firestore, 'units'), where('status', '!=', 'entregada'));

  onSnapshot(q, async (snapshot) => {
    const ahora = Date.now();
    const limiteReciente = ahora - (45 * 60 * 1000); // Ventana de 45 minutos hacia atrás

    if (esCargaInicial) {
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data();
        estadosConocidos.set(docSnap.id, {
          status: data.status,
          unit_number: data.unit_number
        });
      });
      esCargaInicial = false;
      console.log(`⚡ Sincronización inicial: ${estadosConocidos.size} unidades en memoria.`);

      // A) Marcar unidades viejas (> 45 min) como ya notificadas para evitar spam de días anteriores
      let huboMarcadoViejo = false;
      for (const docSnap of snapshot.docs) {
        const docId = docSnap.id;
        const unit = docSnap.data();
        const fechaCreacion = unit.created_date ? new Date(unit.created_date).getTime() : 0;

        if (fechaCreacion < limiteReciente && !notifiedSet.has(docId + '_ingreso')) {
          notifiedSet.add(docId + '_ingreso');
          huboMarcadoViejo = true;
        }

        if (unit.status === 'lista') {
          const listaEvent = Array.isArray(unit.timeline) 
            ? [...unit.timeline].reverse().find(t => t.status === 'lista') 
            : null;
          const fechaLista = listaEvent?.date ? new Date(listaEvent.date).getTime() : fechaCreacion;
          if (fechaLista < limiteReciente && !notifiedSet.has(docId + '_lista')) {
            notifiedSet.add(docId + '_lista');
            huboMarcadoViejo = true;
          }
        }
      }

      if (huboMarcadoViejo) {
        const items = Array.from(notifiedSet).slice(-500);
        await setDoc(doc(firestore, '_system', 'whatsapp_notified'), {
          items,
          updated_at: new Date().toISOString()
        }).catch(() => {});
      }

      // B) RECUPERACIÓN AUTOMÁTICA: Si alguna unidad se creó o quedó lista en los últimos 45 min
      // (por ejemplo mientras el servidor Render dormía o se reiniciaba) y no se había notificado,
      // enviarla de inmediato para no perder ninguna unidad.
      for (const docSnap of snapshot.docs) {
        const docId = docSnap.id;
        const unit = docSnap.data();
        const fechaCreacion = unit.created_date ? new Date(unit.created_date).getTime() : 0;

        if (fechaCreacion >= limiteReciente && !notifiedSet.has(docId + '_ingreso')) {
          console.log(`⚡ Recuperando unidad reciente #${unit.unit_number || 'S/N'} creada mientras dormía...`);
          await notificarIngresoSiAplica(docId, unit);
        }

        if (unit.status === 'lista' && !notifiedSet.has(docId + '_lista')) {
          const listaEvent = Array.isArray(unit.timeline) 
            ? [...unit.timeline].reverse().find(t => t.status === 'lista') 
            : null;
          const fechaLista = listaEvent?.date ? new Date(listaEvent.date).getTime() : fechaCreacion;
          if (fechaLista >= limiteReciente) {
            console.log(`⚡ Recuperando unidad terminada #${unit.unit_number || 'S/N'} lista mientras dormía...`);
            await notificarListaSiAplica(docId, unit);
          }
        }
      }
      return;
    }

    // EVENTOS EN TIEMPO REAL
    const changes = snapshot.docChanges();
    for (const change of changes) {
      const docId = change.doc.id;
      const unit = change.doc.data();
      const numUnidad = unit.unit_number || 'S/N';

      // NUEVA UNIDAD
      if (change.type === 'added') {
        estadosConocidos.set(docId, {
          status: unit.status,
          unit_number: numUnidad
        });
        await notificarIngresoSiAplica(docId, unit);
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
          await notificarListaSiAplica(docId, unit);
        }
      }

      if (change.type === 'removed') {
        estadosConocidos.delete(docId);
      }
    }
  }, (error) => {
    console.error('Error en listener de Firebase:', error.message);
    registrarActividad('error', `Listener DB: ${error.message}`, false);
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
    .group-item { background: #0f172a; padding: 12px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #334155; }
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
        <p style="margin: 0; font-size: 14px; color: #cbd5e1;">⏳ Conectando con WhatsApp y restaurando sesión...</p>
        <p style="margin: 6px 0 0 0; font-size: 12px; color: #64748b;">La página se actualizará automáticamente en unos segundos.</p>
      </div>
    ` : ''}

    ${estadoConexion === 'conectado' ? `
      <p style="color: #10b981; font-size: 13px; text-align: center; margin: 10px 0;">✅ WhatsApp vinculado y listo para enviar mensajes.</p>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0;">
        <form action="/probar-ingresos" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #2563eb;">🧪 Probar Mecánicos</button>
        </form>
        <form action="/probar-listas" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #059669;">🧪 Probar Listas</button>
        </form>
        <form action="/reenviar-ultima" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #d97706;">🔁 Reenviar Ingreso ${ultimaUnidadIngreso.numero ? `(#${ultimaUnidadIngreso.numero})` : ''}</button>
        </form>
        <form action="/reenviar-ultima-lista" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #0d9488;">🔁 Reenviar Lista ${ultimaUnidadLista.numero ? `(#${ultimaUnidadLista.numero})` : ''}</button>
        </form>
      </div>

      <form action="/enviar-directo" method="POST" style="margin: 10px 0; background: #0f172a; padding: 10px; border-radius: 8px; border: 1px solid #334155;">
        <label style="font-size: 11px; margin-bottom: 6px; display: block; color: #94a3b8;">💬 Enviar mensaje directo:</label>
        <div style="display: flex; gap: 6px;">
          <select name="destino" style="background: #1e293b; color: white; border: 1px solid #334155; border-radius: 6px; padding: 6px; font-size: 11px;">
            <option value="listas">Unidades Listas</option>
            <option value="ingresos">Mecánicos (Ingreso)</option>
          </select>
          <input type="text" name="texto" placeholder="Ej: 3608 lista" style="flex: 1; padding: 6px 10px; font-size: 12px; background: #1e293b; border: 1px solid #334155; border-radius: 6px; color: white;" required />
          <button type="submit" class="btn-assign btn-green" style="font-size: 11px; padding: 6px 12px;">Enviar</button>
        </div>
      </form>

      <form action="/logout" method="POST" onsubmit="return confirm('¿Seguro que deseas desvincular el celular?');">
        <button type="submit" class="btn btn-danger">Desvincular WhatsApp / Cambiar Celular</button>
      </form>
    ` : ''}
  </div>

  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h2 style="font-size: 15px; margin: 0;">🕒 Actividad Reciente en Vivo:</h2>
      <span style="font-size: 11px; color: #94a3b8;">Últimos eventos</span>
    </div>
    ${historialActividad.length === 0 ? `
      <p style="font-size: 12px; color: #64748b; margin: 0; text-align: center; padding: 12px;">Esperando eventos de unidades o pulsos del despertador...</p>
    ` : `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${historialActividad.map(ev => `
          <div style="background: #0f172a; padding: 8px 12px; border-radius: 8px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; border-left: 3px solid ${ev.ok ? '#10b981' : '#ef4444'};">
            <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;">
              <span style="color: #94a3b8; font-family: monospace; font-size: 11px; margin-right: 6px;">[${ev.hora}]</span>
              <span style="color: ${ev.ok ? '#f1f5f9' : '#f87171'}; font-weight: 500;">${ev.detalle}</span>
            </div>
            <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: ${ev.ok ? '#065f46' : '#7f1d1d'}; color: white; white-space: nowrap;">
              ${ev.tipo.toUpperCase()}
            </span>
          </div>
        `).join('')}
      </div>
    `}
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

  ${estadoConexion === 'conectado' ? `
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2 style="font-size: 15px; margin: 0;">📋 Tus Grupos de WhatsApp:</h2>
        <form action="/cargar-grupos" method="POST" style="margin: 0;">
          <button type="submit" class="btn-assign btn-blue" style="font-size: 12px; padding: 6px 12px;">🔄 Buscar Grupos</button>
        </form>
      </div>

      ${gruposDetectados.length === 0 ? `
        <div style="text-align: center; padding: 16px; background: #0f172a; border-radius: 10px;">
          <p style="font-size: 13px; color: #94a3b8; margin: 0 0 10px 0;">Presiona el botón azul para listar los grupos de tu WhatsApp:</p>
          <form action="/cargar-grupos" method="POST">
            <button type="submit" class="btn btn-save">🔄 Obtener Mis Grupos de WhatsApp</button>
          </form>
        </div>
      ` : `
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
      `}
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
      setTimeout(() => location.reload(), 4000);
    ` : ''}

    // Mantener activo el servidor en Render si esta página está abierta en la PC o celular
    setInterval(() => {
      fetch('/health?from=browser').catch(() => {});
    }, 60000);
  </script>
</body>
</html>
  `);
});

server.post('/cargar-grupos', async (req, res) => {
  await actualizarGrupos();
  res.redirect('/');
});

server.post('/toggle', (req, res) => {
  botActivo = !botActivo;
  res.redirect('/');
});

server.post('/guardar-config', async (req, res) => {
  const { grupoIngresosId, grupoListasId } = req.body;
  config = {
    ...config,
    grupoIngresosId: (grupoIngresosId || '').trim(),
    grupoListasId: (grupoListasId || '').trim()
  };
  guardarConfigLocal(config);
  await guardarConfigEnFirebase(config);
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

server.get('/debug', (req, res) => {
  res.json({
    estadoConexion,
    botActivo,
    hasSocket: !!socketWhatsApp,
    wsReadyState: socketWhatsApp?.ws?.readyState, // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
    user: socketWhatsApp?.user || null,
    gruposCount: gruposDetectados.length,
    config: leerConfig()
  });
});

server.get('/group-info', async (req, res) => {
  config = leerConfig();
  try {
    const meta = await socketWhatsApp.groupMetadata(config.grupoIngresosId);
    res.json({
      ok: true,
      id: meta.id,
      subject: meta.subject,
      myUserId: socketWhatsApp?.user?.id,
      myLid: socketWhatsApp?.user?.lid,
      participants: meta.participants?.map(p => ({ id: p.id, admin: p.admin }))
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

server.get('/force-send', async (req, res) => {
  config = leerConfig();
  try {
    const r = await socketWhatsApp.sendMessage(config.grupoIngresosId, { text: `🔔 Prueba directa: ${new Date().toLocaleTimeString('es-MX')}` });
    res.json({ ok: true, messageId: r?.key?.id, status: r?.status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

server.post('/probar-ingresos', async (req, res) => {
  config = leerConfig();
  await enviarMensajeGrupo(config.grupoIngresosId, `🧪 Prueba de conexión - ${new Date().toLocaleTimeString('es-MX')}`);
  res.redirect('/');
});

server.post('/probar-listas', async (req, res) => {
  config = leerConfig();
  await enviarMensajeGrupo(config.grupoListasId, `🧪 Prueba de conexión - ${new Date().toLocaleTimeString('es-MX')}`);
  res.redirect('/');
});

server.post('/reenviar-ultima', async (req, res) => {
  config = leerConfig();
  try {
    const qLatest = query(collection(firestore, 'units'), orderBy('created_date', 'desc'), limit(1));
    const snapLatest = await getDocs(qLatest);
    if (!snapLatest.empty) {
      const unit = snapLatest.docs[0].data();
      const numUnidad = unit.unit_number || 'S/N';
      const msg = construirMensajeIngreso(unit, numUnidad);
      ultimaUnidadIngreso = { numero: numUnidad, mensaje: msg };
      console.log(`🔁 Reenviando última unidad #${numUnidad} a WhatsApp...`);
      await enviarMensajeGrupo(config.grupoIngresosId, msg);
    }
  } catch (e) {
    console.error('Error al reenviar última:', e.message);
  }
  res.redirect('/');
});

server.post('/reenviar-ultima-lista', async (req, res) => {
  config = leerConfig();
  try {
    const qLatest = query(collection(firestore, 'units'), orderBy('created_date', 'desc'), limit(30));
    const snapLatest = await getDocs(qLatest);
    let targetUnit = null;
    for (const d of snapLatest.docs) {
      const u = d.data();
      const hasLista = u.status === 'lista' || (Array.isArray(u.timeline) && u.timeline.some(t => t.status === 'lista'));
      if (hasLista) {
        targetUnit = u;
        break;
      }
    }
    const num = targetUnit ? (targetUnit.unit_number || 'S/N') : (ultimaUnidadLista.numero || '3608');
    const msg = `${num} lista`;
    ultimaUnidadLista = { numero: num, mensaje: msg };
    console.log(`🔁 Reenviando última lista #${num} a WhatsApp...`);
    await enviarMensajeGrupo(config.grupoListasId, msg);
  } catch (e) {
    console.error('Error al reenviar última lista:', e.message);
  }
  res.redirect('/');
});

server.post('/enviar-directo', async (req, res) => {
  config = leerConfig();
  const { destino, texto } = req.body;
  if (texto && texto.trim()) {
    const targetGroup = destino === 'ingresos' ? config.grupoIngresosId : config.grupoListasId;
    console.log(`💬 Enviando mensaje directo manual: "${texto.trim()}"`);
    await enviarMensajeGrupo(targetGroup, texto.trim());
  }
  res.redirect('/');
});

server.all(['/health', '/Health'], async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  let origen = 'Despertador externo';
  if (req.query.from === 'browser') origen = 'Navegador Web';
  else if (ua.includes('uptimerobot')) origen = 'UptimeRobot';
  else if (ua.includes('cron-job')) origen = 'cron-job.org';

  registrarActividad('pulso', `Pulso (${origen})`, true);
  res.status(200).type('text/plain').send('OK');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🌐 Servidor Web activo en el puerto ${PORT}`);
  await autenticarFirebase();
  await restaurarConfigDesdeFirebase();
  await cargarNotificadosDesdeFirebase();
  await iniciarWhatsApp();
});
