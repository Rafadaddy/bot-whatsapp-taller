process.env.TZ = 'America/Mexico_City';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import express from 'express';

// Captura de logs en memoria para diagnóstico remoto vía /logs
const systemLogs = [];
function agregarLog(level, msg) {
  const time = new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
  systemLogs.push({ time, level, msg });
  if (systemLogs.length > 250) systemLogs.shift();
}

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  origLog(...args);
  agregarLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.warn = (...args) => {
  origWarn(...args);
  agregarLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.error = (...args) => {
  origError(...args);
  agregarLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

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
let modoHorarioAutomatico = true;
let forzadoManual = null; // null = horario automático; true = manual encendido; false = manual pausa
let botActivo = false;
let estadoConexion = 'iniciando'; // 'iniciando', 'esperando_qr', 'conectado', 'desconectado'
let ultimoQRDataURL = null;
let gruposDetectados = [];
let socketWhatsApp = null;
let listenerIniciado = false;
const estadosConocidos = new Map();
let notifiedSet = new Set();
let historialActividad = [];
const MAX_HISTORIAL = 100;
let ultimaUnidadIngreso = { numero: '', mensaje: '' };
let ultimaUnidadLista = { numero: '', mensaje: '' };
let ultimaFechaReporteEstatus = '';
let colaPendientes = [];
let horarioConfig = {
  semanaInicio: '09:00',
  semanaFin: '20:00',
  finSemanaInicio: '09:00',
  finSemanaFin: '17:00'
};

function obtenerFechaHoraMexico() {
  const ahora = new Date();
  const formato = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    hourCycle: 'h23',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(ahora);

  const parts = {};
  for (const p of formato) {
    parts[p.type] = p.value;
  }
  
  const diaSemanaMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const diaSemana = diaSemanaMap[parts.weekday] ?? ahora.getDay();
  let hora = parseInt(parts.hour, 10);
  if (hora === 24) hora = 0;
  const minuto = parseInt(parts.minute, 10);

  return { diaSemana, hora, minuto };
}

function estaEnHorarioLaboral() {
  const { diaSemana, hora, minuto } = obtenerFechaHoraMexico();
  const tiempoMinutos = hora * 60 + minuto;

  const [semIniH, semIniM] = (horarioConfig.semanaInicio || '09:00').split(':').map(Number);
  const [semFinH, semFinM] = (horarioConfig.semanaFin || '20:00').split(':').map(Number);
  const [finIniH, finIniM] = (horarioConfig.finSemanaInicio || '09:00').split(':').map(Number);
  const [finFinH, finFinM] = (horarioConfig.finSemanaFin || '17:00').split(':').map(Number);

  const semInicioMinutos = semIniH * 60 + semIniM;
  const semFinMinutos = semFinH * 60 + semFinM;
  const finInicioMinutos = finIniH * 60 + finIniM;
  const finFinMinutos = finFinH * 60 + finFinM;

  // Lunes a Viernes (1 a 5)
  if (diaSemana >= 1 && diaSemana <= 5) {
    return tiempoMinutos >= semInicioMinutos && tiempoMinutos < semFinMinutos;
  }
  
  // Sábado y Domingo (6 y 0)
  if (diaSemana === 6 || diaSemana === 0) {
    return tiempoMinutos >= finInicioMinutos && tiempoMinutos < finFinMinutos;
  }

  return false;
}

function actualizarEstadoHorario(notificarCambio = false) {
  if (!modoHorarioAutomatico) {
    botActivo = forzadoManual !== false;
    return;
  }

  const dentroDeHorario = estaEnHorarioLaboral();
  const estadoAnterior = botActivo;
  botActivo = dentroDeHorario;

  if (notificarCambio && estadoAnterior !== botActivo) {
    if (botActivo) {
      console.log('⏰ [HORARIO] Inicio de turno laboral. Bot activado automáticamente.');
      registrarActividad('horario', 'Inicio de turno: Bot activado automáticamente', true);
    } else {
      console.log('⏰ [HORARIO] Fin de turno laboral. Bot pausado automáticamente.');
      registrarActividad('horario', 'Fin de turno: Bot pausado automáticamente', false);
    }
  }
}

// Inicializar el estado de horario al cargar el módulo
actualizarEstadoHorario(false);

// ==========================================
// 1. VIGILANTE ANTI-CONGELAMIENTO (WATCHDOG RENDER)
// Detecta si Render congeló/durmió el contenedor y se acaba de despertar
// ==========================================
let ultimoTickVigilante = Date.now();
setInterval(() => {
  const ahora = Date.now();
  const diferencia = ahora - ultimoTickVigilante;
  ultimoTickVigilante = ahora;

  // Si entre dos ticks de 10s pasaron más de 45 segundos, Render congeló y reanudó el contenedor
  if (diferencia > 45000) {
    const segDormido = Math.round(diferencia / 1000);
    console.warn(`⚠️ [WATCHDOG] El servidor de Render se acaba de despertar tras ${segDormido}s en reposo.`);
    registrarActividad('app', `⚡ Despertar de reposo (${segDormido}s)`, true);

    // Si WhatsApp estaba marcado como conectado, el socket TCP seguramente murió en el servidor de WhatsApp.
    // Lo refrescamos de inmediato para que esté 100% fresco antes de recibir mensajes de unidades.
    if (socketWhatsApp && estadoConexion === 'conectado') {
      console.log('🔄 [WATCHDOG] Refrescando conexión de WhatsApp tras despertar de reposo...');
      iniciarWhatsApp();
    }
  }
}, 10000);

// ==========================================
// 2. DESPERTADOR ACTIVO (KEEP-ALIVE HTTP INTERNO)
// Envía un pulso HTTP a la URL pública cada 8 min durante horario laboral
// (Render en plan gratuito se duerme a los 15 min de inactividad)
// ==========================================
const RENDER_PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://bot-whatsapp-taller.onrender.com';

setInterval(async () => {
  if (estaEnHorarioLaboral()) {
    try {
      // Pulso HTTP a la URL pública para reiniciar el contador de inactividad de Render
      await fetch(`${RENDER_PUBLIC_URL}/health?from=internal_heartbeat_${Date.now()}`).catch(() => {});
      
      // Ping de presencia en WhatsApp para mantener viva la conexión TCP
      if (socketWhatsApp && estadoConexion === 'conectado') {
        await socketWhatsApp.sendPresenceUpdate('available').catch(() => {});
      }
    } catch (e) {}
  }
}, 8 * 60 * 1000);

async function generarTextoEstatusTaller() {
  try {
    const snap = await getDocs(collection(firestore, 'units'));
    const activeUnits = [];
    
    snap.forEach(d => {
      const u = d.data();
      // Excluir entregadas, listas, paros técnicos y trámites legales
      if (!['entregada', 'lista', 'paro_tecnico', 'tramite_legal'].includes(u.status)) {
        activeUnits.push(u);
      }
    });

    if (activeUnits.length === 0) {
      return null;
    }

    // Ordenar cronológicamente descendente: la última que ingresó al taller queda hasta arriba
    activeUnits.sort((a, b) => {
      const timeA = new Date(a.created_date || a.entry_date || 0).getTime();
      const timeB = new Date(b.created_date || b.entry_date || 0).getTime();
      if (timeB !== timeA) return timeB - timeA;
      return (b.unit_number || '').localeCompare(a.unit_number || '', undefined, { numeric: true });
    });

    const now = new Date();
    const fechaStr = now.toLocaleDateString('es-ES', { 
      timeZone: 'America/Mexico_City', 
      day: '2-digit', 
      month: 'long' 
    });

    const lineas = activeUnits.map(u => {
      const num = u.unit_number || 'S/N';
      
      let fallasText = [];
      if (u.reason && !u.reason_resolved) fallasText.push(u.reason);
      if (Array.isArray(u.faults)) {
        const activeFaults = u.faults
          .filter(f => f.status !== 'resuelta')
          .map(f => typeof f === 'string' ? f : (f.description || f.cause || ''))
          .filter(Boolean);
        fallasText = [...new Set([...fallasText, ...activeFaults])];
      }
      const fallas = fallasText.length > 0 ? fallasText.join(' // ') : (u.reported_fault || 'En revisión');

      // Si está por falta de refacción, recalcar la refacción faltante
      if (u.status === 'espera_refaccion') {
        const pieza = u.missing_parts_desc ? u.missing_parts_desc.trim() : 'Sin especificar';
        return `*${num}* ${fallas} ⚠️ (POR FALTA DE REFACCIÓN: ${pieza})`;
      }

      // Unidades normales en taller: limpias sin saturar
      return `*${num}* ${fallas}`;
    });

    return `*ESTATUS DE TALLER ${fechaStr.toUpperCase()}*\n\n` + lineas.join('\n\n');
  } catch (err) {
    console.error('Error al generar reporte de estatus:', err.message);
    return null;
  }
}

async function enviarReporteEstatusTaller(manual = false) {
  config = leerConfig();
  if (!config.grupoIngresosId) {
    console.warn('⚠️ No se puede enviar el estatus: falta asignar el ID del grupo de Mecánicos.');
    if (manual) registrarActividad('error', 'Sin grupo de Mecánicos asignado', false);
    return false;
  }

  // NUNCA enviar automáticamente fuera del horario laboral
  if (!manual && (!botActivo || !estaEnHorarioLaboral())) {
    console.warn('⚠️ Intento de reporte automático cancelado: fuera de horario laboral.');
    return false;
  }

  console.log(`📋 ${manual ? '[MANUAL]' : '[AUTOMÁTICO]'} Generando reporte de estatus del taller...`);
  const textoReporte = await generarTextoEstatusTaller();
  if (!textoReporte) {
    console.log('ℹ️ No hay unidades activas en taller para reportar.');
    if (manual) registrarActividad('reporte', 'Sin unidades activas en taller', true);
    return false;
  }

  const ok = await enviarMensajeGrupo(config.grupoIngresosId, textoReporte);
  if (ok) {
    const ahoraMx = new Date().toLocaleDateString('es-CA', { timeZone: 'America/Mexico_City' }); // YYYY-MM-DD
    ultimaFechaReporteEstatus = ahoraMx;
    registrarActividad('reporte', `Estatus taller enviado a Mecánicos (${manual ? 'Manual' : 'Automático'})`, true);
    try {
      await setDoc(doc(firestore, '_system', 'whatsapp_config'), {
        ...config,
        ultimaFechaReporteEstatus: ahoraMx
      }, { merge: true });
    } catch (e) {}
    return true;
  }
  return false;
}

async function checarEnvioReporteDiario() {
  // BLOQUEO ABSOLUTO: Nunca enviar si el bot no está activo o está fuera de horario laboral
  if (!botActivo || !estaEnHorarioLaboral()) return;

  const { diaSemana, hora, minuto } = obtenerFechaHoraMexico();
  const hoyStr = new Date().toLocaleDateString('es-CA', { timeZone: 'America/Mexico_City' }); // YYYY-MM-DD

  const esFinDeSemana = (diaSemana === 6 || diaSemana === 0);
  const horaInicioStr = esFinDeSemana ? (horarioConfig.finSemanaInicio || '09:00') : (horarioConfig.semanaInicio || '09:00');
  const [hIni, mIni] = horaInicioStr.split(':').map(Number);

  const minutosActuales = hora * 60 + minuto;
  const minutosInicio = hIni * 60 + mIni;

  // Se activa automáticamente al iniciar el turno (o al conectar en la mañana) si no se ha enviado hoy
  if (minutosActuales >= minutosInicio && ultimaFechaReporteEstatus !== hoyStr && estadoConexion === 'conectado') {
    console.log(`⏰ [${horaInicioStr}] Enviando reporte diario automático de estatus a Mecánicos...`);
    await enviarReporteEstatusTaller(false);
  }
}

// Chequeo periódico cada 30 segundos
setInterval(async () => {
  actualizarEstadoHorario(true);
  await checarEnvioReporteDiario();
}, 30000);

function esperarConexion(timeoutMs = 15000) {
  if (socketWhatsApp && estadoConexion === 'conectado') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (socketWhatsApp && estadoConexion === 'conectado') {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 500);
  });
}

function encolarPendiente(item) {
  // REGLA ESTRICTA: Fuera de horario o en pausa NUNCA se encola nada
  if (!botActivo || !estaEnHorarioLaboral()) {
    return;
  }
  if (!colaPendientes.some(p => p.clave === item.clave)) {
    console.log(`📥 Guardando en cola inmediata (máx 15s) para reconexión: "${item.texto}"`);
    registrarActividad('espera', `En cola (15s): ${item.texto}`, false);
    colaPendientes.push({
      ...item,
      timestamp: item.timestamp || Date.now()
    });
  }
}

async function procesarColaPendientes() {
  if (colaPendientes.length === 0 || estadoConexion !== 'conectado') return;

  // Si está fuera de horario, limpiar inmediatamente sin enviar nada
  if (!botActivo || !estaEnHorarioLaboral()) {
    console.log(`🧹 Limpiando ${colaPendientes.length} mensaje(s) retenidos porque el bot está fuera de horario.`);
    colaPendientes = [];
    return;
  }

  const ahora = Date.now();
  // REGLA ESTRICTA: Descartar cualquier mensaje que tenga más de 15 segundos
  const pendientesValidos = [];
  for (const p of colaPendientes) {
    const edadMs = ahora - (p.timestamp || 0);
    if (edadMs <= 15000) {
      pendientesValidos.push(p);
    } else {
      console.log(`⏱️ [DESCARTADO >15s] Mensaje caducado hace ${Math.round(edadMs / 1000)}s: "${p.texto}". No se enviará.`);
      await guardarNotificadoEnFirebase(p.clave);
    }
  }

  colaPendientes = [];
  if (pendientesValidos.length === 0) return;

  console.log(`📋 Procesando ${pendientesValidos.length} mensaje(s) reciente(s) en cola...`);
  for (const item of pendientesValidos) {
    try {
      console.log(`🚀 Despachando mensaje inmediato: "${item.texto}"`);
      const ok = await enviarMensajeGrupo(item.grupoId, item.texto);
      if (ok) {
        await guardarNotificadoEnFirebase(item.clave);
      }
    } catch (e) {
      console.error('Error al procesar mensaje de cola:', e.message);
    }
  }
}

async function actualizarUltimaUnidad(tipo, info) {
  if (tipo === 'ingreso') ultimaUnidadIngreso = info;
  if (tipo === 'lista') ultimaUnidadLista = info;
  try {
    await setDoc(doc(firestore, '_system', 'whatsapp_config'), {
      ...config,
      ultimaUnidadIngreso,
      ultimaUnidadLista
    }, { merge: true });
  } catch (e) {}
}

async function inicializarUltimasUnidades() {
  try {
    const qIngresos = query(collection(firestore, 'units'), orderBy('created_date', 'desc'), limit(1));
    const snapIngreso = await getDocs(qIngresos);
    if (!snapIngreso.empty) {
      const u = snapIngreso.docs[0].data();
      const num = u.unit_number || 'S/N';
      ultimaUnidadIngreso = { numero: num, mensaje: construirMensajeIngreso(u, num) };
    }

    const qListas = query(collection(firestore, 'units'), orderBy('created_date', 'desc'), limit(50));
    const snapListas = await getDocs(qListas);
    let unitsWithLista = [];
    for (const d of snapListas.docs) {
      const u = d.data();
      let fechaLista = 0;
      if (Array.isArray(u.timeline)) {
        const tLista = [...u.timeline].reverse().find(t => t.status === 'lista');
        if (tLista && tLista.date) fechaLista = new Date(tLista.date).getTime();
      }
      if (u.status === 'lista' && !fechaLista) {
        fechaLista = u.updated_date ? new Date(u.updated_date).getTime() : (u.created_date ? new Date(u.created_date).getTime() : 0);
      }
      if (fechaLista > 0) unitsWithLista.push({ unit: u, fechaLista });
    }
    unitsWithLista.sort((a, b) => b.fechaLista - a.fechaLista);
    if (unitsWithLista.length > 0) {
      const num = unitsWithLista[0].unit.unit_number || 'S/N';
      ultimaUnidadLista = { numero: num, mensaje: `${num} lista` };
    }
    console.log(`📌 Unidades para reenvío listas: Ingreso #${ultimaUnidadIngreso.numero}, Lista #${ultimaUnidadLista.numero}`);
  } catch (e) {
    console.warn('Error al inicializar últimas unidades:', e.message);
  }
}

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
      if (typeof data.modoHorarioAutomatico === 'boolean') modoHorarioAutomatico = data.modoHorarioAutomatico;
      if (data.forzadoManual !== undefined) forzadoManual = data.forzadoManual;
      if (data.ultimaUnidadIngreso) ultimaUnidadIngreso = data.ultimaUnidadIngreso;
      if (data.ultimaUnidadLista) ultimaUnidadLista = data.ultimaUnidadLista;
      if (data.ultimaFechaReporteEstatus) ultimaFechaReporteEstatus = data.ultimaFechaReporteEstatus;
      if (data.horarioConfig) horarioConfig = { ...horarioConfig, ...data.horarioConfig };
      guardarConfigLocal(config);
      actualizarEstadoHorario(false);
      console.log('🎯 Configuración y horario restaurados desde la nube:', config);
    }
  } catch (e) {
    console.warn('No se pudo restaurar config desde Firebase:', e.message);
  }
}

async function guardarEstadoHorarioEnFirebase() {
  try {
    await setDoc(doc(firestore, '_system', 'whatsapp_config'), {
      ...config,
      modoHorarioAutomatico,
      forzadoManual
    }, { merge: true });
  } catch (e) {}
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
        limpiarPrekeysAntiguas(AUTH_DIR, 40);
        console.log('✅ ¡Sesión de WhatsApp restaurada con éxito!');
        return true;
      }
    }
  } catch (e) {
    console.warn('No se pudo restaurar sesión de Firebase:', e.message);
  }
  return false;
}

// Función para purgar pre-keys obsoletas y evitar que la sesión acumule cientos de archivos
function limpiarPrekeysAntiguas(authFolder, maxPrekeys = 40) {
  try {
    if (!fs.existsSync(authFolder)) return;
    const files = fs.readdirSync(authFolder);
    const preKeys = [];

    for (const file of files) {
      const match = file.match(/^pre-key-(\d+)\.json$/);
      if (match) {
        preKeys.push({ file, id: parseInt(match[1], 10) });
      }
    }

    if (preKeys.length > maxPrekeys) {
      preKeys.sort((a, b) => a.id - b.id);
      const aEliminar = preKeys.slice(0, preKeys.length - maxPrekeys);
      for (const item of aEliminar) {
        try {
          fs.unlinkSync(path.join(authFolder, item.file));
        } catch (e) {}
      }
      console.log(`🧹 [LIMPIEZA] Eliminadas ${aEliminar.length} pre-keys viejas. Conservadas las ${maxPrekeys} más recientes.`);
    }
  } catch (err) {
    console.warn('Aviso en limpieza de prekeys:', err.message);
  }
}

// Limpiar prekeys periódicamente cada 15 minutos en segundo plano
setInterval(() => {
  limpiarPrekeysAntiguas(AUTH_DIR, 40);
}, 15 * 60 * 1000);

let debounceRespaldoTimeout = null;
function programarRespaldoSesion(retrasoMs = 20000) {
  if (debounceRespaldoTimeout) clearTimeout(debounceRespaldoTimeout);
  debounceRespaldoTimeout = setTimeout(async () => {
    debounceRespaldoTimeout = null;
    await respaldarSesionAFirebase();
  }, retrasoMs);
}

async function respaldarSesionAFirebase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    limpiarPrekeysAntiguas(AUTH_DIR, 40); // Purgar antes de guardar en la nube
    const fileList = fs.readdirSync(AUTH_DIR);
    const files = {};
    let totalBytes = 0;

    // Priorizar creds.json y archivos críticos
    const sortedFiles = fileList.sort((a, b) => {
      if (a === 'creds.json') return -1;
      if (b === 'creds.json') return 1;
      return 0;
    });

    for (const f of sortedFiles) {
      const fullPath = path.join(AUTH_DIR, f);
      if (fs.statSync(fullPath).isFile()) {
        const contentBase64 = fs.readFileSync(fullPath).toString('base64');
        // Firestore tiene límite de 1MB por documento; limitar a ~850KB para seguridad
        if (totalBytes + contentBase64.length < 850000) {
          files[f] = contentBase64;
          totalBytes += contentBase64.length;
        }
      }
    }

    if (Object.keys(files).length > 0) {
      await setDoc(doc(firestore, '_system', 'whatsapp_session'), {
        files,
        updated_at: new Date().toISOString()
      });
      console.log(`💾 Sesión respaldada en Firebase (${Object.keys(files).length} archivos, ${Math.round(totalBytes / 1024)} KB).`);
    }
  } catch (e) {
    console.warn('Aviso al respaldar sesión en Firebase:', e.message);
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
    
    // Garantizar que los grupos configurados y el grupo de prueba tengan participantes completos para cifrado
    config = leerConfig();
    const gruposClave = [config.grupoIngresosId, config.grupoListasId, '120363431907400300@g.us'].filter(Boolean);
    for (const gId of gruposClave) {
      try {
        const fullMeta = await socketWhatsApp.groupMetadata(gId);
        if (fullMeta && Array.isArray(fullMeta.participants)) {
          groupMetadataCache.set(gId, fullMeta);
          console.log(`✅ [METADATA] ${fullMeta.subject || gId} sincronizado con ${fullMeta.participants.length} participantes.`);
        }
      } catch (errG) {
        console.warn(`Aviso al cargar metadata de ${gId}:`, errG.message);
      }
    }

    console.log(`📋 ¡${gruposDetectados.length} grupos detectados y sincronizados con éxito!`);
  } catch (e) {
    console.warn('Reintentando sincronizar grupos...', e.message);
  }
}

// 2. Conexión de WhatsApp
const mensajeStore = new Map();
const groupMetadataCache = new Map();
let ultimasConfirmaciones = [];

async function iniciarWhatsApp() {
  estadoConexion = 'iniciando';
  console.log('⏳ Iniciando WhatsApp Baileys...');
  
  // Limpiar socket anterior si existía para evitar conexiones zombi
  if (socketWhatsApp) {
    try {
      socketWhatsApp.ev.removeAllListeners();
      socketWhatsApp.end?.();
    } catch (e) {}
    socketWhatsApp = null;
  }

  await restaurarSesionDesdeFirebase();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  socketWhatsApp = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false,
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    cachedGroupMetadata: async (jid) => {
      let meta = groupMetadataCache.get(jid);
      if (!meta || !Array.isArray(meta.participants) || meta.participants.length === 0) {
        try {
          meta = await socketWhatsApp?.groupMetadata(jid);
          if (meta) groupMetadataCache.set(jid, meta);
        } catch (e) {}
      }
      return meta;
    },
    getMessage: async (key) => {
      if (key && key.id && mensajeStore.has(key.id)) {
        return mensajeStore.get(key.id);
      }
      return { conversation: '' };
    }
  });

  socketWhatsApp.ev.on('creds.update', async () => {
    await saveCreds();
    programarRespaldoSesion(20000); // Debounce de 20s para proteger cuota de Firestore
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
      programarRespaldoSesion(5000);

      // Esperar 5 segundos a que el handshake y la sincronización se estabilicen
      setTimeout(actualizarGrupos, 5000);
      setTimeout(procesarColaPendientes, 6000);

      if (!listenerIniciado) {
        iniciarListenerFirebase();
        listenerIniciado = true;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Conexión de WhatsApp cerrada (Código: ${statusCode}). Reintentando reconexión automática en 3s...`);
      estadoConexion = 'iniciando';
      // Si el código es 500 (Bad Session) o 503, purgar pre-keys y sender-keys obsoletas para forzar re-negociación limpia sin perder creds.json
      if (statusCode === 500 || statusCode === 503) {
        try {
          if (fs.existsSync(AUTH_DIR)) {
            const files = fs.readdirSync(AUTH_DIR);
            for (const f of files) {
              if (f.startsWith('pre-key-') || f.startsWith('sender-key-')) {
                try { fs.unlinkSync(path.join(AUTH_DIR, f)); } catch (e) {}
              }
            }
            console.log('🧹 [RECUPERACIÓN CÓDIGO 500] Llaves temporales limpiadas para re-sincronización limpia.');
          }
        } catch (e) {}
      }
      setTimeout(iniciarWhatsApp, 3000);
    }
  });

  socketWhatsApp.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      const status = update.update?.status;
      if (status !== undefined) {
        console.log(`📬 Mensaje confirmado por WhatsApp (Status ${status}): ${update.key.id}`);
        ultimasConfirmaciones.unshift({
          id: update.key.id,
          status,
          hora: new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' })
        });
        if (ultimasConfirmaciones.length > 25) ultimasConfirmaciones.pop();
      }
    }
  });
}

// Cola de serialización: impide que mensajes cruzados o concurrentes colisionen en el socket de WhatsApp
let colaEnvioSerial = Promise.resolve();

async function enviarMensajeGrupo(grupoId, texto) {
  return new Promise((resolve) => {
    colaEnvioSerial = colaEnvioSerial.then(async () => {
      try {
        const resultado = await ejecutarEnvioReal(grupoId, texto);
        // Pausa de 1.5s entre mensajes para que el cifrado y la red no choquen
        await new Promise(r => setTimeout(r, 1500));
        resolve(resultado);
      } catch (err) {
        console.error('Error en cola serial:', err.message);
        resolve(false);
      }
    });
  });
}

// Enviar mensajes a WhatsApp de forma controlada y protegida
async function ejecutarEnvioReal(grupoId, texto) {
  if (!botActivo || (modoHorarioAutomatico && !estaEnHorarioLaboral())) {
    console.log(`⏸️ [PAUSADO/FUERA DE HORARIO] Mensaje no enviado: "${texto}"`);
    registrarActividad('pausa', `Fuera de turno: ${texto}`, false);
    return false;
  }

  // Si WhatsApp se está reconectando en ese instante, esperar hasta 15 segundos
  if (!socketWhatsApp || estadoConexion !== 'conectado') {
    console.log(`⏳ WhatsApp reconectando (${estadoConexion}). Esperando hasta 15s para enviar: "${texto}"...`);
    const listo = await esperarConexion(15000);
    if (!listo) {
      console.warn(`[!] No se pudo enviar mensaje porque WhatsApp no reconectó a tiempo.`);
      registrarActividad('error', `WhatsApp desconectado: ${texto}`, false);
      return false;
    }
  }

  if (!grupoId || grupoId.trim() === '') {
    console.warn(`[!] Falta configurar el ID del grupo en la página de control.`);
    registrarActividad('error', `Sin grupo asignado: ${texto}`, false);
    return false;
  }

  // Asegurar metadata y participantes del grupo antes de cifrar y enviar
  if (grupoId.endsWith('@g.us') && socketWhatsApp) {
    const meta = groupMetadataCache.get(grupoId);
    if (!meta || !Array.isArray(meta.participants) || meta.participants.length === 0) {
      try {
        console.log(`🔍 Cargando participantes de grupo ${grupoId} antes de enviar...`);
        const freshMeta = await socketWhatsApp.groupMetadata(grupoId);
        if (freshMeta) groupMetadataCache.set(grupoId, freshMeta);
      } catch (e) {
        console.warn(`Aviso al cargar metadata de ${grupoId}:`, e.message);
      }
    }
  }

  let ultimoError = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      if (intento === 2) {
        console.log(`🔄 Reintentando envío (${intento}/2): refrescando conexión de WhatsApp...`);
        iniciarWhatsApp();
        await esperarConexion(12000);
      }

      const res = await socketWhatsApp.sendMessage(grupoId, { text: texto });
      if (res && res.key && res.key.id) {
        mensajeStore.set(res.key.id, res.message);
        if (mensajeStore.size > 200) {
          const firstKey = mensajeStore.keys().next().value;
          mensajeStore.delete(firstKey);
        }
      }
      console.log(`📨 [${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' })}] Enviado a ${grupoId}: "${texto}"`);
      registrarActividad('envio', texto, true);
      return true;
    } catch (error) {
      ultimoError = error;
      console.error(`❌ Error al enviar mensaje (Intento ${intento}):`, error.message);
    }
  }

  registrarActividad('error', `Error al enviar tras 2 intentos: ${ultimoError?.message || 'Desconocido'}`, false);
  return false;
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

  // Excluir entregadas, listas, paros técnicos y trámites legales (petición expresa del usuario)
  if (['entregada', 'lista', 'paro_tecnico', 'tramite_legal'].includes(unit.status)) {
    console.log(`⏸️ [#${numUnidad}] Unidad con estatus '${unit.status}'. Omitiendo notificación de ingreso.`);
    notifiedSet.add(clave);
    await guardarNotificadoEnFirebase(clave);
    return false;
  }

  // REGLA ESTRICTA ANTI-DESVELO: Si el taller está cerrado o el bot pausado, NUNCA enviar ni encolar
  if (!botActivo || !estaEnHorarioLaboral()) {
    console.log(`⏸️ [FUERA DE HORARIO / APAGADO] #${numUnidad} registrada con bot inactivo o taller cerrado. Descartando notificación.`);
    registrarActividad('descarte', `#${numUnidad} omitida (bot apagado o fuera de turno)`, false);
    notifiedSet.add(clave);
    await guardarNotificadoEnFirebase(clave);
    return false;
  }

  const mensaje = construirMensajeIngreso(unit, numUnidad);
  actualizarUltimaUnidad('ingreso', { numero: numUnidad, mensaje });
  console.log(`\n🆕 [NUEVA UNIDAD EN VIVO] #${numUnidad} -> Enviando a WhatsApp...`);
  config = leerConfig();
  const ok = await enviarMensajeGrupo(config.grupoIngresosId, mensaje);
  if (ok) {
    await guardarNotificadoEnFirebase(clave);
    return true;
  } else {
    // Solo reintentar en cola si WhatsApp se estaba reconectando en ese instante (máx 15s)
    encolarPendiente({
      grupoId: config.grupoIngresosId,
      texto: mensaje,
      clave,
      timestamp: Date.now()
    });
    return false;
  }
}

async function notificarListaSiAplica(docId, unit) {
  const clave = docId + '_lista';
  if (notifiedSet.has(clave)) return false;

  const numUnidad = unit.unit_number || 'S/N';

  // REGLA ESTRICTA ANTI-DESVELO: Si el taller está cerrado o el bot pausado, NUNCA enviar ni encolar
  if (!botActivo || !estaEnHorarioLaboral()) {
    console.log(`⏸️ [FUERA DE HORARIO / APAGADO] #${numUnidad} lista con bot inactivo o taller cerrado. Descartando notificación.`);
    registrarActividad('descarte', `Lista #${numUnidad} omitida (bot apagado o fuera de turno)`, false);
    notifiedSet.add(clave);
    await guardarNotificadoEnFirebase(clave);
    return false;
  }

  const mensaje = `${numUnidad} lista`;
  actualizarUltimaUnidad('lista', { numero: numUnidad, mensaje });
  console.log(`\n🎉 [UNIDAD LISTA EN VIVO] #${numUnidad} lista -> Enviando a WhatsApp...`);
  config = leerConfig();
  const ok = await enviarMensajeGrupo(config.grupoListasId, mensaje);
  if (ok) {
    await guardarNotificadoEnFirebase(clave);
    return true;
  } else {
    // Solo reintentar en cola si WhatsApp se estaba reconectando en ese instante (máx 15s)
    encolarPendiente({
      grupoId: config.grupoListasId,
      texto: mensaje,
      clave,
      timestamp: Date.now()
    });
    return false;
  }
}

// 3. Listener en tiempo real de Firebase
function iniciarListenerFirebase() {
  console.log('📡 Conectando a la base de datos de unidades en vivo...');
  let esCargaInicial = true;
  const q = query(collection(firestore, 'units'), where('status', '!=', 'entregada'));

  onSnapshot(q, async (snapshot) => {
    if (esCargaInicial) {
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data();
        estadosConocidos.set(docSnap.id, {
          status: data.status,
          unit_number: data.unit_number
        });
      });
      esCargaInicial = false;
      console.log(`⚡ Sincronización inicial: ${estadosConocidos.size} unidades activas en memoria.`);

      // REGLA DEL USUARIO: "No mandar cosas atrasadas, máximo 2 minutos si el bot estaba arrancando".
      const ahoraMs = Date.now();
      const LIMITE_RECIENTE_MS = 2 * 60 * 1000; // Máximo 2 minutos exactos
      const pendientesDeArranque = [];

      for (const docSnap of snapshot.docs) {
        const docId = docSnap.id;
        const unit = docSnap.data();
        const fechaCreacion = new Date(unit.created_date || 0).getTime();
        const esMuyReciente = fechaCreacion > 0 && ((ahoraMs - fechaCreacion) <= LIMITE_RECIENTE_MS);

        if (notifiedSet.has(docId + '_ingreso')) {
          // Ya fue notificado en el pasado
        } else if (esMuyReciente && !['entregada', 'lista', 'paro_tecnico', 'tramite_legal'].includes(unit.status)) {
          // Entró hace menos de 2 minutos mientras el bot despertaba
          pendientesDeArranque.push({ tipo: 'ingreso', docId, unit });
        } else {
          // Más de 2 minutos: marcar como notificado para evitar retrasos y duplicados manuales
          notifiedSet.add(docId + '_ingreso');
        }

        if (unit.status === 'lista') {
          let fechaLista = 0;
          if (Array.isArray(unit.timeline)) {
            const tLista = [...unit.timeline].reverse().find(t => t.status === 'lista');
            if (tLista?.date) fechaLista = new Date(tLista.date).getTime();
          }
          const listaMuyReciente = fechaLista > 0 && ((ahoraMs - fechaLista) <= LIMITE_RECIENTE_MS);
          if (notifiedSet.has(docId + '_lista')) {
            // Ya notificado
          } else if (listaMuyReciente) {
            pendientesDeArranque.push({ tipo: 'lista', docId, unit });
          } else {
            notifiedSet.add(docId + '_lista');
          }
        }
      }

      const items = Array.from(notifiedSet).slice(-500);
      await setDoc(doc(firestore, '_system', 'whatsapp_notified'), {
        items,
        updated_at: new Date().toISOString()
      }).catch(() => {});

      // Despachar inmediatamente cualquier unidad de los últimos 2 minutos
      for (const p of pendientesDeArranque) {
        if (p.tipo === 'ingreso') {
          console.log(`⚡ [ARRANQUE <2 min] Despachando ingreso reciente #${p.unit.unit_number}...`);
          await notificarIngresoSiAplica(p.docId, p.unit);
        } else if (p.tipo === 'lista') {
          console.log(`⚡ [ARRANQUE <2 min] Despachando lista reciente #${p.unit.unit_number}...`);
          await notificarListaSiAplica(p.docId, p.unit);
        }
      }
      return;
    }

    // EVENTOS EN TIEMPO REAL ÚNICAMENTE
    const changes = snapshot.docChanges();

    for (const change of changes) {
      const docId = change.doc.id;
      const unit = change.doc.data();
      const numUnidad = unit.unit_number || 'S/N';

      // NUEVA UNIDAD
      if (change.type === 'added') {
        // Si ya existía desde el inicio o por reconexión interna, no duplicar
        if (estadosConocidos.has(docId)) {
          estadosConocidos.set(docId, {
            status: unit.status,
            unit_number: numUnidad
          });
          continue;
        }

        estadosConocidos.set(docId, {
          status: unit.status,
          unit_number: numUnidad
        });

        // Si ya fue notificado previamente, omitir
        if (notifiedSet.has(docId + '_ingreso')) {
          continue;
        }

        console.log(`🆕 [NUEVA UNIDAD EN VIVO] #${numUnidad} detectada.`);
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
          if (notifiedSet.has(docId + '_lista')) {
            console.log(`ℹ️ [#${numUnidad}] Ya fue notificada como lista anteriormente. Omitiendo duplicado.`);
            continue;
          }

          console.log(`🎉 [UNIDAD LISTA EN VIVO] #${numUnidad} cambió a 'lista'.`);
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
    listenerIniciado = false;
    setTimeout(() => {
      console.log('🔄 Reintentando conectar listener de Firebase en 5s...');
      iniciarListenerFirebase();
      listenerIniciado = true;
    }, 5000);
  });
}

// 4. Servidor Web Express (Panel de Control)
const server = express();
server.use(express.json());
server.use(express.urlencoded({ extended: true }));

server.get('/', (req, res) => {
  actualizarEstadoHorario(false);
  config = leerConfig();
  const serverTimestamp = Date.now();
  res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Taller Teziutlán - Control y Notificaciones</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .card { background: #1e293b; border-radius: 16px; padding: 18px; max-width: 520px; margin: 0 auto 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); border: 1px solid #334155; }
    h1 { font-size: 18px; margin: 0 0 14px 0; display: flex; align-items: center; justify-content: space-between; }
    h2 { font-size: 15px; margin: 0 0 10px 0; color: #f1f5f9; display: flex; align-items: center; justify-content: space-between; }
    .badge { font-size: 12px; padding: 6px 12px; border-radius: 20px; font-weight: bold; }
    .badge-conectado { background: #059669; color: #fff; }
    .badge-qr { background: #d97706; color: #fff; animation: pulse 1.5s infinite; }
    .badge-iniciando { background: #6366f1; color: #fff; }
    .badge-desconectado { background: #dc2626; color: #fff; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    .qr-container { text-align: center; margin: 16px 0; background: #fff; padding: 16px; border-radius: 12px; }
    .qr-container img { max-width: 260px; width: 100%; height: auto; }
    .btn { display: inline-block; width: 100%; padding: 11px; font-size: 13px; font-weight: bold; border-radius: 8px; border: none; cursor: pointer; text-align: center; box-sizing: border-box; text-decoration: none; margin-top: 6px; }
    .btn-toggle-on { background: #10b981; color: white; }
    .btn-toggle-off { background: #64748b; color: white; }
    .btn-save { background: #3b82f6; color: white; }
    .btn-purple { background: #6366f1; color: white; }
    .btn-danger { background: #ef4444; color: white; }
    .btn-assign { padding: 6px 10px; font-size: 11px; font-weight: bold; border-radius: 6px; border: none; cursor: pointer; color: white; }
    .btn-blue { background: #2563eb; }
    .btn-green { background: #059669; }
    .form-group { margin-bottom: 12px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px; font-weight: 600; }
    input[type="text"], input[type="time"], select { width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #fff; font-size: 13px; box-sizing: border-box; }
    .tab-bar { display: flex; gap: 6px; background: #0f172a; padding: 4px; border-radius: 12px; border: 1px solid #334155; margin-top: 12px; }
    .tab-btn { flex: 1; padding: 10px 4px; border: none; border-radius: 8px; background: transparent; color: #94a3b8; font-size: 12px; font-weight: bold; cursor: pointer; transition: all 0.2s; }
    .tab-btn.active { background: #2563eb; color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,0.4); }
    .group-item { background: #0f172a; padding: 10px; border-radius: 8px; margin-bottom: 8px; border: 1px solid #334155; }
    .group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .group-name { font-weight: bold; font-size: 13px; color: #f1f5f9; }
    .group-id { color: #38bdf8; font-family: monospace; font-size: 11px; word-break: break-all; }
    .group-actions { display: flex; gap: 8px; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="card" style="margin-bottom: 12px;">
    <h1>
      <span>🤖 Taller Teziutlán</span>
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

    <!-- RELOJ OFICIAL EN VIVO DEL BOT (CDMX) -->
    <div style="background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 10px 14px; margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 22px;">🕒</span>
        <div>
          <div style="font-size: 10px; font-weight: 700; color: #94a3b8; letter-spacing: 0.5px;">HORA OFICIAL DEL BOT (CDMX)</div>
          <div id="reloj-fecha-bot" style="font-size: 12px; color: #cbd5e1; font-weight: 600; text-transform: capitalize;">Cargando fecha...</div>
        </div>
      </div>
      <div id="reloj-hora-bot" style="font-family: monospace; font-size: 16px; font-weight: 900; color: #38bdf8; background: #1e293b; padding: 5px 10px; border-radius: 8px; border: 1px solid #475569; letter-spacing: 0.5px; white-space: nowrap;">
        --:--:--
      </div>
    </div>

    <div class="tab-bar">
      <button type="button" class="tab-btn active" id="btn-tab-monitor" onclick="cambiarTab('monitor')">
        📊 Monitor en Vivo
      </button>
      <button type="button" class="tab-btn" id="btn-tab-config" onclick="cambiarTab('config')">
        ⚙️ Configuración y Botones
      </button>
    </div>
  </div>

  ${estadoConexion === 'esperando_qr' && ultimoQRDataURL ? `
    <div class="card qr-container">
      <p style="color: #0f172a; font-weight: bold; margin-top: 0; font-size: 14px;">Escanea este código con tu WhatsApp:</p>
      <img src="${ultimoQRDataURL}" alt="Código QR WhatsApp" />
      <p style="color: #64748b; font-size: 11px; margin-bottom: 0;">WhatsApp > 3 puntitos > Dispositivos vinculados</p>
    </div>
  ` : ''}

  ${estadoConexion === 'iniciando' || (estadoConexion !== 'conectado' && !ultimoQRDataURL) ? `
    <div class="card" style="text-align: center; padding: 20px 10px;">
      <p style="margin: 0; font-size: 14px; color: #cbd5e1;">⏳ Conectando con WhatsApp y restaurando sesión...</p>
      <p style="margin: 6px 0 0 0; font-size: 12px; color: #64748b;">La página se actualizará automáticamente en unos segundos.</p>
    </div>
  ` : ''}

  <!-- PESTAÑA 1: MONITOR EN VIVO -->
  <div id="tab-monitor">
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 13px; font-weight: bold; color: #94a3b8;">CONTROL DE OPERACIÓN:</span>
        <span style="font-size: 11px; padding: 3px 8px; border-radius: 12px; background: ${!botActivo && !modoHorarioAutomatico ? '#dc2626' : (modoHorarioAutomatico ? '#059669' : '#d97706')}; color: white; font-weight: bold;">
          ${!botActivo && !modoHorarioAutomatico ? '🛑 APAGADO / DESACTIVADO' : (modoHorarioAutomatico ? '🕒 Horario Automático' : '🟢 Manual Forzado')}
        </span>
      </div>

      <!-- Cuadro de estado actual grande y 100% visible -->
      ${!modoHorarioAutomatico && !botActivo ? `
        <div style="background: #450a0a; border: 2px solid #ef4444; border-radius: 10px; padding: 12px; margin-bottom: 12px; text-align: center;">
          <div style="font-size: 15px; font-weight: 900; color: #f87171; margin-bottom: 4px;">🛑 BOT TOTALMENTE DESACTIVADO</div>
          <div style="font-size: 12px; color: #fca5a5;">El bot está 100% apagado en pausa manual. No enviará ningún mensaje por WhatsApp.</div>
        </div>
      ` : (modoHorarioAutomatico ? `
        <div style="background: #0f172a; border: 2px solid ${botActivo ? '#10b981' : '#f59e0b'}; border-radius: 10px; padding: 12px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 13px; font-weight: bold; color: ${botActivo ? '#34d399' : '#fbbf24'};">
              ${botActivo ? '🟢 HORARIO AUTO: DENTRO DE TURNO' : '⏸️ HORARIO AUTO: FUERA DE TURNO (PAUSADO)'}
            </span>
            <span style="font-size: 11px; color: #94a3b8;">${botActivo ? 'Enviando mensajes' : 'En pausa nocturna'}</span>
          </div>
          <div style="font-size: 11px; color: #cbd5e1; line-height: 1.4;">
            📅 <b>Lunes a Viernes:</b> ${horarioConfig.semanaInicio || '09:00'} a ${horarioConfig.semanaFin || '20:00'}<br/>
            📅 <b>Sábado y Domingo:</b> ${horarioConfig.finSemanaInicio || '09:00'} a ${horarioConfig.finSemanaFin || '17:00'}
          </div>
        </div>
      ` : `
        <div style="background: #064e3b; border: 2px solid #10b981; border-radius: 10px; padding: 12px; margin-bottom: 12px; text-align: center;">
          <div style="font-size: 15px; font-weight: 900; color: #34d399; margin-bottom: 4px;">🟢 BOT FORZADO ACTIVO</div>
          <div style="font-size: 12px; color: #a7f3d0;">El bot está encendido manualmente las 24 horas continuas sin importar el reloj.</div>
        </div>
      `)}

      <!-- BOTONES DINÁMICOS PLAY / PAUSA (CERO CONFUSIÓN) -->
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${botActivo ? `
          <!-- SI EL BOT ESTÁ ENVIANDO: BOTÓN PARA PAUSAR -->
          <form action="/desactivar-bot" method="POST" style="margin: 0;">
            <button type="submit" class="btn" style="background: #dc2626; color: white; font-weight: bold; font-size: 14px; padding: 13px 6px; width: 100%; border-radius: 8px; border: none; cursor: pointer; box-shadow: 0 4px 12px rgba(220,38,38,0.4); display: flex; align-items: center; justify-content: center; gap: 8px;">
              ⏸️ PAUSAR BOT (DETENER ENVÍOS)
            </button>
          </form>
        ` : `
          <!-- SI EL BOT ESTÁ PAUSADO: BOTÓN PLAY PARA INICIAR -->
          <form action="${estaEnHorarioLaboral() ? '/activar-horario' : '/activar-bot'}" method="POST" style="margin: 0;">
            <button type="submit" class="btn" style="background: #059669; color: white; font-weight: bold; font-size: 14px; padding: 13px 6px; width: 100%; border-radius: 8px; border: none; cursor: pointer; box-shadow: 0 4px 12px rgba(5,150,105,0.4); display: flex; align-items: center; justify-content: center; gap: 8px;">
              ▶️ INICIAR BOT (PLAY / ACTIVAR)
            </button>
          </form>
        `}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <!-- BOTÓN HORARIO AUTOMÁTICO -->
          <form action="/activar-horario" method="POST" style="margin: 0;">
            <button type="submit" class="btn" style="background: ${modoHorarioAutomatico ? '#1e40af' : '#1e293b'}; color: white; font-weight: 600; font-size: 12px; padding: 10px 4px; width: 100%; border-radius: 8px; border: 1px solid ${modoHorarioAutomatico ? '#60a5fa' : '#475569'}; cursor: pointer;">
              ⏰ Modo Horario Auto
            </button>
          </form>

          <!-- BOTÓN MODO FORZADO 24/7 -->
          <form action="/activar-bot" method="POST" style="margin: 0;">
            <button type="submit" class="btn" style="background: ${(!modoHorarioAutomatico && botActivo) ? '#059669' : '#1e293b'}; color: white; font-weight: 600; font-size: 12px; padding: 10px 4px; width: 100%; border-radius: 8px; border: 1px solid ${(!modoHorarioAutomatico && botActivo) ? '#34d399' : '#475569'}; cursor: pointer;">
              🟢 Modo Forzado 24/7
            </button>
          </form>
        </div>
      </div>
    </div>

    ${estadoConexion === 'conectado' ? `
      <div class="card">
        <h2><span>⚡ Acciones Rápidas</span></h2>
        <form action="/enviar-estatus-diario" method="POST" style="margin: 0 0 8px 0;">
          <button type="submit" class="btn btn-purple" style="font-size: 12px; padding: 11px 4px; margin: 0;">📋 Enviar Estatus del Taller Ahora (Mecánicos)</button>
        </form>
        <div style="display: flex; gap: 8px;">
          <form action="/reenviar-ultima" method="POST" style="flex: 1; margin: 0;">
            <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 9px 2px; margin: 0; background: #d97706;">🔁 Reenviar Ingreso ${ultimaUnidadIngreso.numero ? `(#${ultimaUnidadIngreso.numero})` : ''}</button>
          </form>
          <form action="/reenviar-ultima-lista" method="POST" style="flex: 1; margin: 0;">
            <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 9px 2px; margin: 0; background: #0d9488;">🔁 Reenviar Lista ${ultimaUnidadLista.numero ? `(#${ultimaUnidadLista.numero})` : ''}</button>
          </form>
        </div>
      </div>
    ` : ''}

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <h2 style="margin: 0;">🕒 Actividad Reciente en Vivo:</h2>
        <span style="font-size: 11px; color: #94a3b8;">Últimos eventos</span>
      </div>
      ${historialActividad.length === 0 ? `
        <p style="font-size: 12px; color: #64748b; margin: 0; text-align: center; padding: 12px;">Esperando eventos de unidades o pulsos del despertador...</p>
      ` : `
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${historialActividad.map(ev => `
            <div style="background: #0f172a; padding: 8px 10px; border-radius: 8px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; border-left: 3px solid ${ev.ok ? '#10b981' : '#ef4444'};">
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
  </div>

  <!-- PESTAÑA 2: CONFIGURACIÓN Y BOTONES -->
  <div id="tab-config" style="display: none;">
    <div class="card">
      <h2><span>🕒 Modificar Horarios Laborales</span></h2>
      <p style="font-size: 12px; color: #94a3b8; margin: 0 0 12px 0;">
        Puedes ajustar las horas de inicio y fin cuando lo desees. A la hora de inicio se activa y manda el reporte general; a la de fin se pausa solo.
      </p>
      <form action="/guardar-horarios" method="POST">
        <div style="background: #0f172a; padding: 12px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #334155;">
          <label style="color: #38bdf8; font-size: 12px; margin-bottom: 6px;">📅 Lunes a Viernes:</label>
          <div style="display: flex; gap: 8px; align-items: center;">
            <div style="flex: 1;">
              <span style="font-size: 11px; color: #94a3b8;">Hora Inicio:</span>
              <input type="time" name="semanaInicio" value="${horarioConfig.semanaInicio || '09:00'}" required />
            </div>
            <div style="flex: 1;">
              <span style="font-size: 11px; color: #94a3b8;">Hora Fin:</span>
              <input type="time" name="semanaFin" value="${horarioConfig.semanaFin || '20:00'}" required />
            </div>
          </div>
        </div>

        <div style="background: #0f172a; padding: 12px; border-radius: 10px; margin-bottom: 12px; border: 1px solid #334155;">
          <label style="color: #38bdf8; font-size: 12px; margin-bottom: 6px;">📅 Sábado y Domingo:</label>
          <div style="display: flex; gap: 8px; align-items: center;">
            <div style="flex: 1;">
              <span style="font-size: 11px; color: #94a3b8;">Hora Inicio:</span>
              <input type="time" name="finSemanaInicio" value="${horarioConfig.finSemanaInicio || '09:00'}" required />
            </div>
            <div style="flex: 1;">
              <span style="font-size: 11px; color: #94a3b8;">Hora Fin:</span>
              <input type="time" name="finSemanaFin" value="${horarioConfig.finSemanaFin || '17:00'}" required />
            </div>
          </div>
        </div>

        <button type="submit" class="btn btn-save" style="margin-top: 0;">💾 Guardar Nuevos Horarios</button>
      </form>
    </div>

    ${estadoConexion === 'conectado' ? `
      <div class="card">
        <h2><span>🧪 Pruebas de Diagnóstico</span></h2>
        <p style="font-size: 11px; color: #94a3b8; margin: 0 0 8px 0;">Para verificar la entrega sin afectar la operación laboral, usa el botón del Grupo Prueba:</p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <form action="/probar-prueba-post" method="POST" style="margin: 0;">
            <button type="submit" class="btn btn-save" style="font-size: 12px; padding: 11px 4px; margin: 0; background: #6366f1;">🧪 Probar Grupo Prueba (Seguro - No afecta trabajo)</button>
          </form>
          <div style="display: flex; gap: 8px;">
            <form action="/probar-ingresos" method="POST" style="flex: 1; margin: 0;">
              <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #2563eb;">🧪 Probar Mecánicos</button>
            </form>
            <form action="/probar-listas" method="POST" style="flex: 1; margin: 0;">
              <button type="submit" class="btn btn-save" style="font-size: 11px; padding: 10px 2px; margin: 0; background: #059669;">🧪 Probar Listas</button>
            </form>
          </div>
        </div>
      </div>

      <div class="card">
        <h2><span>💬 Enviar Mensaje Directo</span></h2>
        <form action="/enviar-directo" method="POST">
          <div class="form-group">
            <label>Destino:</label>
            <select name="destino">
              <option value="prueba">Grupo Prueba (120363431907400300@g.us) [Seguro]</option>
              <option value="ingresos">Mecánicos Teziutlan (Ingresos)</option>
              <option value="listas">Unidades Listas ✅</option>
            </select>
          </div>
          <div class="form-group">
            <label>Texto del mensaje:</label>
            <input type="text" name="texto" placeholder="Ej: 3608 lista" required />
          </div>
          <button type="submit" class="btn btn-green" style="margin-top: 0;">Enviar a WhatsApp</button>
        </form>
      </div>
    ` : ''}

    <div class="card">
      <h2><span>🎯 Grupos Asignados</span></h2>
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
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h2 style="margin: 0;">📋 Tus Grupos de WhatsApp:</h2>
          <form action="/cargar-grupos" method="POST" style="margin: 0;">
            <button type="submit" class="btn-assign btn-blue" style="font-size: 11px; padding: 5px 10px;">🔄 Buscar Grupos</button>
          </form>
        </div>

        ${gruposDetectados.length === 0 ? `
          <div style="text-align: center; padding: 14px; background: #0f172a; border-radius: 10px;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0 0 8px 0;">Presiona el botón azul para listar los grupos de tu WhatsApp:</p>
            <form action="/cargar-grupos" method="POST">
              <button type="submit" class="btn btn-save" style="font-size: 12px; padding: 8px;">🔄 Obtener Mis Grupos de WhatsApp</button>
            </form>
          </div>
        ` : `
          <p style="font-size: 11px; color: #94a3b8; margin-top: 0;">Toca el botón azul o verde para asignar el grupo directamente:</p>
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

      <div class="card">
        <h2><span style="color: #f87171;">⚠️ Conexión del Celular</span></h2>
        <form action="/logout" method="POST" onsubmit="return confirm('¿Seguro que deseas desvincular el celular?');">
          <button type="submit" class="btn btn-danger" style="margin-top: 0;">Desvincular WhatsApp / Cambiar Celular</button>
        </form>
      </div>
    ` : ''}
  </div>

  <script>
    function cambiarTab(tab) {
      document.getElementById('tab-monitor').style.display = tab === 'monitor' ? 'block' : 'none';
      document.getElementById('tab-config').style.display = tab === 'config' ? 'block' : 'none';
      document.getElementById('btn-tab-monitor').classList.toggle('active', tab === 'monitor');
      document.getElementById('btn-tab-config').classList.toggle('active', tab === 'config');
      localStorage.setItem('taller_active_tab', tab);
      if (tab === 'config') window.location.hash = 'config';
      else window.location.hash = 'monitor';
    }

    // Inicializar pestaña activa
    const initialTab = (window.location.hash === '#config' || localStorage.getItem('taller_active_tab') === 'config') ? 'config' : 'monitor';
    cambiarTab(initialTab);

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

    // Reloj oficial del bot sincronizado en vivo (CDMX)
    const serverBootTime = ${serverTimestamp};
    const clientBootTime = Date.now();
    const serverOffset = serverBootTime - clientBootTime;

    function actualizarRelojBot() {
      const serverDate = new Date(Date.now() + serverOffset);
      const opcionesFecha = { 
        timeZone: 'America/Mexico_City', 
        weekday: 'long', 
        day: 'numeric', 
        month: 'long' 
      };
      const opcionesHora = { 
        timeZone: 'America/Mexico_City', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: true 
      };
      
      const fechaStr = serverDate.toLocaleDateString('es-MX', opcionesFecha);
      const horaStr = serverDate.toLocaleTimeString('es-MX', opcionesHora);
      
      const elFecha = document.getElementById('reloj-fecha-bot');
      const elHora = document.getElementById('reloj-hora-bot');
      
      if (elFecha) elFecha.textContent = fechaStr.charAt(0).toUpperCase() + fechaStr.slice(1);
      if (elHora) elHora.textContent = horaStr;
    }

    actualizarRelojBot();
    setInterval(actualizarRelojBot, 1000);
  </script>
</body>
</html>
  `);
});

server.post('/cargar-grupos', async (req, res) => {
  await actualizarGrupos();
  res.redirect('/');
});

server.post('/desactivar-bot', async (req, res) => {
  modoHorarioAutomatico = false;
  forzadoManual = false;
  botActivo = false;
  colaPendientes = [];
  registrarActividad('modo', '🛑 BOT TOTALMENTE DESACTIVADO (APAGADO)', false);
  console.log('🛑 [MODO] Bot desactivado manualmente por el usuario.');
  await guardarEstadoHorarioEnFirebase();
  res.redirect('/');
});

server.post('/activar-bot', async (req, res) => {
  modoHorarioAutomatico = false;
  forzadoManual = true;
  botActivo = true;
  registrarActividad('modo', '🟢 BOT ENCENDIDO FORZADO (MANUAL)', true);
  console.log('🟢 [MODO] Bot encendido manualmente por el usuario.');
  await guardarEstadoHorarioEnFirebase();
  res.redirect('/');
});

server.post('/activar-horario', async (req, res) => {
  modoHorarioAutomatico = true;
  forzadoManual = null;
  actualizarEstadoHorario(true);
  registrarActividad('modo', '⏰ MODO HORARIO AUTOMÁTICO RESTAURADO', true);
  console.log('⏰ [MODO] Horario automático restaurado por el usuario.');
  await guardarEstadoHorarioEnFirebase();
  res.redirect('/');
});

server.post('/toggle-horario', async (req, res) => {
  modoHorarioAutomatico = !modoHorarioAutomatico;
  if (modoHorarioAutomatico) {
    forzadoManual = null;
    actualizarEstadoHorario(true);
  } else {
    forzadoManual = botActivo;
  }
  await guardarEstadoHorarioEnFirebase();
  res.redirect('/');
});

server.post('/toggle', async (req, res) => {
  if (modoHorarioAutomatico) {
    // Si estaba en automático y tocan el botón, pasar a modo manual con el estado inverso
    modoHorarioAutomatico = false;
    forzadoManual = !botActivo;
    botActivo = forzadoManual;
    registrarActividad('modo', `Cambiado a Modo Manual: ${botActivo ? 'ACTIVO' : 'PAUSADO'}`, true);
  } else {
    forzadoManual = !botActivo;
    botActivo = forzadoManual;
    registrarActividad('modo', `Modo Manual: ${botActivo ? 'ACTIVO' : 'PAUSADO'}`, true);
  }
  await guardarEstadoHorarioEnFirebase();
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
  res.redirect('/#config');
});

server.post('/guardar-horarios', async (req, res) => {
  const { semanaInicio, semanaFin, finSemanaInicio, finSemanaFin } = req.body;
  horarioConfig = {
    semanaInicio: semanaInicio || '09:00',
    semanaFin: semanaFin || '20:00',
    finSemanaInicio: finSemanaInicio || '09:00',
    finSemanaFin: finSemanaFin || '17:00'
  };
  actualizarEstadoHorario(true);
  try {
    await setDoc(doc(firestore, '_system', 'whatsapp_config'), {
      ...config,
      horarioConfig
    }, { merge: true });
    console.log('💾 Nuevos horarios guardados en Firebase:', horarioConfig);
    registrarActividad('horario', `Horarios actualizados: L-V ${horarioConfig.semanaInicio}-${horarioConfig.semanaFin}, S-D ${horarioConfig.finSemanaInicio}-${horarioConfig.finSemanaFin}`, true);
  } catch (e) {
    console.error('Error al guardar horarios:', e.message);
  }
  res.redirect('/#config');
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
    modoHorarioAutomatico,
    forzadoManual,
    dentroDeHorarioLaboral: estaEnHorarioLaboral(),
    horarioConfig,
    horaMexico: obtenerFechaHoraMexico(),
    hasSocket: !!socketWhatsApp,
    user: socketWhatsApp?.user || null,
    gruposCount: gruposDetectados.length,
    listenerIniciado,
    estadosConocidosCount: estadosConocidos.size,
    config: leerConfig(),
    ultimaFechaReporteEstatus,
    ultimasConfirmaciones
  });
});

server.get('/logs', (req, res) => {
  res.type('text/plain; charset=utf-8').send(
    systemLogs.length === 0 
      ? 'Sin logs recientes todavía.' 
      : systemLogs.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.msg}`).join('\n')
  );
});

server.get('/reset-reporte', (req, res) => {
  ultimaFechaReporteEstatus = '';
  res.json({ ok: true, msg: 'Reporte matutino reseteado. Listo para enviarse a la hora programada.' });
});

// Endpoint seguro para pruebas: solo prueba contra el grupo de prueba
server.get('/probar-prueba', async (req, res) => {
  const grupoPrueba = '120363431907400300@g.us';
  const texto = req.query.texto || `🧪 Diagnóstico Grupo Prueba [${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}]`;
  try {
    if (!socketWhatsApp || estadoConexion !== 'conectado') {
      return res.json({ ok: false, error: `WhatsApp no conectado (Estado: ${estadoConexion})` });
    }
    console.log(`🧪 [TEST PRUEBA] Enviando mensaje de prueba a ${grupoPrueba}...`);
    try {
      const meta = await socketWhatsApp.groupMetadata(grupoPrueba);
      groupMetadataCache.set(grupoPrueba, meta);
      console.log(`🧪 [TEST PRUEBA] Metadata obtenida: "${meta.subject}", participantes: ${meta.participants?.length}`);
    } catch (errM) {
      console.warn(`🧪 [TEST PRUEBA] Aviso al obtener metadata: ${errM.message}`);
    }
    
    let ackRecibido = false;
    let statusRecibido = 1;
    const inicio = Date.now();
    const r = await socketWhatsApp.sendMessage(grupoPrueba, { text: texto });
    const msgId = r?.key?.id;
    console.log(`🧪 [TEST PRUEBA] sendMessage devolvió msgId: ${msgId}, status: ${r?.status}`);

    await new Promise((resolve) => {
      const listener = (updates) => {
        for (const u of updates) {
          if (u.key?.id === msgId) {
            statusRecibido = u.update?.status;
            console.log(`🧪 [TEST PRUEBA] Update para ${msgId}: status ${statusRecibido}`);
            if (statusRecibido >= 2) {
              ackRecibido = true;
              try { socketWhatsApp.ev.off('messages.update', listener); } catch (e) {}
              resolve();
              return;
            }
          }
        }
      };
      socketWhatsApp.ev.on('messages.update', listener);
      setTimeout(() => {
        try { socketWhatsApp.ev.off('messages.update', listener); } catch (e) {}
        resolve();
      }, 10000);
    });

    res.json({
      ok: true,
      destino: grupoPrueba,
      msgId,
      ackRecibido,
      statusFinal: statusRecibido,
      duracionMs: Date.now() - inicio
    });
  } catch (err) {
    console.error(`🧪 [TEST PRUEBA] Error al enviar:`, err);
    res.json({ ok: false, error: err.message, stack: err.stack });
  }
});

server.get('/probar-entrega', async (req, res) => {
  config = leerConfig();
  const grupo = req.query.id || (req.query.grupo === 'listas' ? config.grupoListasId : (req.query.grupo === 'prueba' ? '120363431907400300@g.us' : config.grupoIngresosId));
  const texto = req.query.texto || `🧪 Diagnóstico de entrega [${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}]`;

  try {
    let ackRecibido = false;
    let statusRecibido = 1;

    const r = await socketWhatsApp.sendMessage(grupo, { text: texto });
    const msgId = r?.key?.id;

    // Esperar hasta 8 segundos a ver si WhatsApp confirma con status >= 2 (SERVER_ACK)
    const inicio = Date.now();
    await new Promise((resolve) => {
      const listener = (updates) => {
        for (const u of updates) {
          if (u.key?.id === msgId) {
            statusRecibido = u.update?.status;
            if (statusRecibido >= 2) {
              ackRecibido = true;
              socketWhatsApp.ev.off('messages.update', listener);
              resolve();
              return;
            }
          }
        }
      };
      socketWhatsApp.ev.on('messages.update', listener);
      setTimeout(() => {
        socketWhatsApp.ev.off('messages.update', listener);
        resolve();
      }, 8000);
    });

    res.json({
      ok: true,
      messageId: msgId,
      ackRecibido,
      statusFinal: statusRecibido,
      duracionMs: Date.now() - inicio,
      destino: grupo
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

server.get('/group-info', async (req, res) => {
  config = leerConfig();
  try {
    const targetGroup = req.query.id || (req.query.tipo === 'listas' ? config.grupoListasId : config.grupoIngresosId);
    const meta = await socketWhatsApp.groupMetadata(targetGroup);
    res.json({
      ok: true,
      id: meta.id,
      subject: meta.subject,
      announce: meta.announce,
      restrict: meta.restrict,
      participantsCount: meta.participants?.length || 0,
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
    const r = await socketWhatsApp.sendMessage(config.grupoIngresosId, { text: `🔔 Prueba directa: ${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}` });
    res.json({ ok: true, messageId: r?.key?.id, status: r?.status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

server.post('/probar-ingresos', async (req, res) => {
  config = leerConfig();
  await enviarMensajeGrupo(config.grupoIngresosId, `🧪 Prueba de conexión - ${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}`);
  res.redirect('/');
});

server.post('/probar-listas', async (req, res) => {
  config = leerConfig();
  await enviarMensajeGrupo(config.grupoListasId, `🧪 Prueba de conexión - ${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}`);
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
    const qLatest = query(collection(firestore, 'units'), orderBy('created_date', 'desc'), limit(50));
    const snapLatest = await getDocs(qLatest);
    let unitsWithLista = [];
    for (const d of snapLatest.docs) {
      const u = d.data();
      let fechaLista = 0;
      if (Array.isArray(u.timeline)) {
        const tLista = [...u.timeline].reverse().find(t => t.status === 'lista');
        if (tLista && tLista.date) fechaLista = new Date(tLista.date).getTime();
      }
      if (u.status === 'lista' && !fechaLista) {
        fechaLista = u.updated_date ? new Date(u.updated_date).getTime() : (u.created_date ? new Date(u.created_date).getTime() : 0);
      }
      if (fechaLista > 0) unitsWithLista.push({ unit: u, fechaLista });
    }
    unitsWithLista.sort((a, b) => b.fechaLista - a.fechaLista);
    const targetUnit = unitsWithLista.length > 0 ? unitsWithLista[0].unit : null;
    const num = targetUnit ? (targetUnit.unit_number || 'S/N') : (ultimaUnidadLista.numero || 'S/N');
    const msg = `${num} lista`;
    actualizarUltimaUnidad('lista', { numero: num, mensaje: msg });
    console.log(`🔁 Reenviando última lista #${num} a WhatsApp...`);
    await enviarMensajeGrupo(config.grupoListasId, msg);
  } catch (e) {
    console.error('Error al reenviar última lista:', e.message);
  }
  res.redirect('/');
});

server.post('/enviar-estatus-diario', async (req, res) => {
  await enviarReporteEstatusTaller(true);
  res.redirect('/');
});

server.post('/probar-prueba-post', async (req, res) => {
  const grupoPrueba = '120363431907400300@g.us';
  const texto = `🧪 Prueba de conexión [${new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: true })}]`;
  console.log(`🧪 Enviando prueba segura a grupo Prueba (${grupoPrueba})...`);
  await enviarMensajeGrupo(grupoPrueba, texto);
  res.redirect('/');
});

server.post('/enviar-directo', async (req, res) => {
  config = leerConfig();
  const { destino, texto } = req.body;
  if (texto && texto.trim()) {
    let targetGroup = config.grupoListasId;
    if (destino === 'prueba') targetGroup = '120363431907400300@g.us';
    else if (destino === 'ingresos') targetGroup = config.grupoIngresosId;
    console.log(`💬 Enviando mensaje directo manual a ${targetGroup}: "${texto.trim()}"`);
    await enviarMensajeGrupo(targetGroup, texto.trim());
  }
  res.redirect('/');
});

server.all(['/health', '/Health'], async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Solo registrar si viene de una acción expresa en la App del Taller para no saturar el historial
  if (req.query.from === 'app_taller_action') {
    registrarActividad('app', '⚡ Despertador App Taller activado', true);
  }
  res.status(200).type('text/plain').send('OK');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🌐 Servidor Web activo en el puerto ${PORT}`);
  await autenticarFirebase();
  await restaurarConfigDesdeFirebase();
  await cargarNotificadosDesdeFirebase();
  await inicializarUltimasUnidades();
  if (!listenerIniciado) {
    iniciarListenerFirebase();
    listenerIniciado = true;
  }
  await iniciarWhatsApp();
});

// Manejo de apagado ordenado para evitar falsas alertas de Render al actualizar
process.on('SIGTERM', () => {
  console.log('🛑 [SIGTERM] Render deteniendo contenedor para actualización. Cierre limpio...');
  if (socketWhatsApp) {
    try { socketWhatsApp.end(); } catch (e) {}
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  if (socketWhatsApp) {
    try { socketWhatsApp.end(); } catch (e) {}
  }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ [Excepción protegida]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Rechazo protegido]:', reason);
});
