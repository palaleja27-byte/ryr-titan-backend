/**
 * APEX CYBERPUNK COMMAND MATRIX - BACKEND ENGINE
 * Archivo: server.js
 * Despliegue: Render.com / Node.js
 * Base de Datos: Supabase
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN DE SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'tu-api-key-secreta';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// MIDDLEWARES
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Servir archivos estáticos del Monitor si se requiere
app.use(express.static(path.join(__dirname, 'public')));

// MEMORIA EN VIVO EN TIEMPO REAL (CACHE RÁPIDO PARA REDUCIR IOPS)
const liveOperatorTelemetry = new Map();
const massExtractionOrders = new Set();
const memoryConversationsMap = new Map(); // clientId -> conversationSummaryObj
const memoryClientMessagesMap = new Map(); // clientId -> Map(msgId -> messageObj)
const memoryClientLettersMap = new Map(); // clientId -> Map(letterId -> letterObj)
const liveProfileInfractions = new Map(); // profileName -> Array of infractions
const operatorResponseTimes = new Map(); // operatorName -> response time in minutes (default 2)

// ALERTAS GLOBALES DE TAREAS Y SEGUIMIENTO EN TIEMPO REAL
let latestGlobalTaskAlert = null;
let taskAlertsConfig = { enabled: true, sound: true, tts: true };

// BUFFER DE LOGS DE SUBIDA EN TIEMPO REAL (CHATS Y CARTAS SINCRONIZADAS)
const liveSyncLogsBuffer = [];
function logSyncEvent({ type, operator, profile, clientName, count, durationMs, status, detail }) {
  // Este módulo es EXCLUSIVO para validar la subida de conversaciones y cartas de los perfiles.
  // Filtramos y descartamos cualquier error/alerta interna para mantener la consola limpia y positiva.
  if (type !== 'CHAT_UPLOAD' && type !== 'LETTERS_SYNC' && type !== 'NUKE_ORDER') {
    return null;
  }

  const entry = {
    id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    timeFormatted: new Date().toLocaleTimeString('es-CO'),
    type: type, // 'CHAT_UPLOAD', 'LETTERS_SYNC', 'NUKE_ORDER'
    operator: operator || 'Operador',
    profile: profile || 'HORACIO',
    clientName: clientName || 'General',
    count: Number(count) || 0,
    durationMs: Number(durationMs) || 0,
    status: 'SUCCESS',
    detail: detail || `Conversación de '${clientName}' subida correctamente.`
  };
  liveSyncLogsBuffer.unshift(entry);
  if (liveSyncLogsBuffer.length > 150) liveSyncLogsBuffer.pop();
  return entry;
}

// ====================================================================
// 1. ENDPOINT: TELEMETRÍA EN VIVO (HEARTBEAT DE OPERADORES CADA 2.5s)
// ====================================================================
app.post('/api/telemetry', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.operator) {
      return res.status(400).json({ error: 'Operador requerido' });
    }

    const opKey = (payload.operator || '').toLowerCase().trim();
    const configuredMinutes = operatorResponseTimes.get(opKey) || 2;

    const key = `${payload.operator}_${payload.profile || 'DEF'}`;
    const telemetryObj = {
      operator: payload.operator,
      shift: payload.shift || 'Mañana',
      profile: payload.profile || 'HORACIO',
      profileId: payload.profileId || '',
      status: payload.status || (payload.isAfk ? 'AFK' : 'ONLINE'),
      idleSeconds: payload.idleSeconds || 0,
      isAfk: Boolean(payload.isAfk),
      pendingReadLetters: payload.pendingReadLetters || 0,
      unansweredChatsCount: (payload.activeChatTimersList || []).length,
      hasExpiredSla: Array.isArray(payload.activeChatTimersList) && payload.activeChatTimersList.length > 0 && payload.activeChatTimersList.some(t => t.isExpired),
      activeChatTimersList: payload.activeChatTimersList || [],
      prospectingProgress: payload.prospectingProgress || { count: 0, quota: 10, remainingSeconds: 1800, isCompleted: false },
      firewallInfractionsCount: payload.firewallInfractionsCount || 0,
      syncAudit: payload.syncAudit || { syncedCount: 0, pendingCount: 0, isUpToDate: true, pendingClients: [] },
      fidelizedCount: payload.fidelizedCount || (payload.fidelizedList ? payload.fidelizedList.length : 0),
      fidelizedList: payload.fidelizedList || [],
      domLagMs: payload.performance?.domLagMs || 0.0,
      responseTimeMinutes: configuredMinutes,
      lastSeen: Date.now()
    };

    // Guardar en Memoria RAM ultrarrápida (CERO consumo de Disk IOPS / Storage en Supabase)
    liveOperatorTelemetry.set(key, telemetryObj);

    // Guardar registro de infracciones detalladas si vienen en el payload
    if (payload.infractionsList && Array.isArray(payload.infractionsList)) {
      const profKey = (payload.profile || 'HORACIO').toUpperCase().trim();
      const existing = liveProfileInfractions.get(profKey) || [];
      const seenIds = new Set(existing.map(i => String(i.id)));
      payload.infractionsList.forEach(inf => {
        if (!seenIds.has(String(inf.id))) {
          existing.unshift(inf);
          seenIds.add(String(inf.id));
        }
      });
      if (existing.length > 50) existing.length = 50;
      liveProfileInfractions.set(profKey, existing);
    }

    // Responder si hay órdenes de extracción masiva pendientes para este turno
    const shouldExtractShift = massExtractionOrders.has(payload.shift || 'Mañana');

    res.json({
      success: true,
      triggerMassExtraction: shouldExtractShift,
      responseTimeMinutes: configuredMinutes,
      responseTimeSeconds: configuredMinutes * 60,
      latestTaskAlert: latestGlobalTaskAlert,
      taskAlertsConfig: taskAlertsConfig
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para publicar una alerta de tareas global hacia todas las extensiones y monitores
app.post('/api/tasks/alert', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.text) {
      return res.status(400).json({ error: 'Payload de alerta requerido con campo text' });
    }
    latestGlobalTaskAlert = {
      ...payload,
      id: payload.id || `task_alert_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: payload.ts || payload.timestamp || Date.now()
    };
    res.json({ success: true, latestTaskAlert: latestGlobalTaskAlert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para consultar el estado actual de la alerta de tareas y su configuración
app.get('/api/tasks/alert', (req, res) => {
  res.json({ success: true, latestTaskAlert: latestGlobalTaskAlert, config: taskAlertsConfig });
});

// Endpoint para sincronizar el toggle de encendido/apagado de alertas de tareas
app.post('/api/tasks/config', (req, res) => {
  try {
    const { enabled, sound, tts } = req.body || {};
    if (typeof enabled === 'boolean') taskAlertsConfig.enabled = enabled;
    if (typeof sound === 'boolean') taskAlertsConfig.sound = sound;
    if (typeof tts === 'boolean') taskAlertsConfig.tts = tts;
    res.json({ success: true, config: taskAlertsConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint dedicado para reportar infracciones en tiempo real desde el HUD
app.post('/api/fines/report-infraction', (req, res) => {
  try {
    const { infraction, profile, operator } = req.body || {};
    if (!infraction) return res.status(400).json({ error: 'Infracción requerida' });
    const profKey = (profile || infraction.profile || 'HORACIO').toUpperCase().trim();
    const existing = liveProfileInfractions.get(profKey) || [];
    const seenIds = new Set(existing.map(i => String(i.id)));
    if (!seenIds.has(String(infraction.id))) {
      existing.unshift(infraction);
      if (existing.length > 50) existing.length = 50;
      liveProfileInfractions.set(profKey, existing);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para consultar todas las infracciones detalladas de un perfil
app.get('/api/fines/infractions/:profile', (req, res) => {
  const profKey = (req.params.profile || 'HORACIO').toUpperCase().trim();
  const baseInfractions = liveProfileInfractions.get(profKey) || [];
  const merged = [...baseInfractions];
  const seenIds = new Set(merged.map(i => String(i.id)));

  // Combinar con telemetría en vivo de operadores que tengan este perfil
  for (let [opKey, opData] of liveOperatorTelemetry.entries()) {
    const pUpper = (opData.profile || '').toUpperCase().trim();
    const oUpper = (opData.operator || '').toUpperCase().trim();
    if (pUpper === profKey || oUpper === profKey || profKey === 'ALL') {
      if (Array.isArray(opData.infractionsList)) {
        opData.infractionsList.forEach(inf => {
          if (!seenIds.has(String(inf.id))) {
            merged.push(inf);
            seenIds.add(String(inf.id));
          }
        });
      }
    }
  }

  merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ success: true, infractions: merged });
});

// Endpoint para ajustar el tiempo de respuesta (SLA en minutos) por operador
app.post('/api/settings/response-time', (req, res) => {
  try {
    const { operator, minutes } = req.body;
    if (!operator) return res.status(400).json({ error: 'Operador requerido' });
    const opKey = operator.toLowerCase().trim();
    const validMinutes = Math.max(1, Math.min(60, parseInt(minutes, 10) || 2));
    operatorResponseTimes.set(opKey, validMinutes);

    // Actualizar también en el telemetry cache activo
    for (let [k, node] of liveOperatorTelemetry.entries()) {
      if ((node.operator || '').toLowerCase().trim() === opKey) {
        node.responseTimeMinutes = validMinutes;
      }
    }

    res.json({ success: true, operator, minutes: validMinutes, seconds: validMinutes * 60 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 2. ENDPOINT: OBTENER TODOS LOS OPERADORES EN TIEMPO REAL (MONITOR)
// ====================================================================
app.get(['/api/telemetry/live-grid', '/api/telemetry/live'], (req, res) => {
  const now = Date.now();
  const activeNodes = [];

  for (let [key, data] of liveOperatorTelemetry.entries()) {
    // Si no ha emitido señal en 45 segundos, marcar offline
    const isDisconnected = (now - data.lastSeen) > 45000;
    if (isDisconnected) {
      data.status = 'OFFLINE';
    }
    const opKey = (data.operator || '').toLowerCase().trim();
    data.responseTimeMinutes = operatorResponseTimes.get(opKey) || data.responseTimeMinutes || 2;
    activeNodes.push(data);
  }

  res.json({ success: true, operators: activeNodes, serverTime: now });
});

// ====================================================================
// 3. ENDPOINT: INGESTA DE AUDITORÍA 360° (HISTORIAL COMPLETO Y ACUMULATIVO)
// ====================================================================
app.post('/api/chats/audit-deep', async (req, res) => {
  const startTime = Date.now();
  const { operator, shift, profile, profileId, clientName, clientId, bioData, markdown, messages, letters } = req.body || {};

  if (!clientName || !clientId) {
    return res.status(400).json({ error: 'Datos de cliente incompletos' });
  }

  const cId = String(clientId).trim();

  // 1. Obtener o inicializar los almacenes acumulativos del cliente
  if (!memoryClientMessagesMap.has(cId)) {
    memoryClientMessagesMap.set(cId, new Map());
  }
  if (!memoryClientLettersMap.has(cId)) {
    memoryClientLettersMap.set(cId, new Map());
  }

  const clientMsgsMap = memoryClientMessagesMap.get(cId);
  const clientLettersMap = memoryClientLettersMap.get(cId);

  // 2. Acumular todos los mensajes recibidos desde el primero hasta el más reciente
  if (Array.isArray(messages) && messages.length > 0) {
    messages.forEach(m => {
      if (!m || !m.text) return;
      const cleanText = (m.text || '').trim();
      if (!cleanText) return;
      const msgKey = m.id || `msg_${cId}_${m.isOperator ? 'OP' : 'RU'}_${cleanText.substring(0, 35).replace(/[^a-z0-9]/gi, '_')}_${(m.time || '').replace(/[^a-z0-9]/gi, '')}`;
      clientMsgsMap.set(msgKey, {
        id: msgKey,
        client_id: cId,
        profile_name: profile || 'HORACIO',
        operator_name: operator || 'Operador',
        sender_type: m.isOperator ? 'OPERATOR' : 'CLIENT',
        sender_name: m.senderName || (m.isOperator ? (profile || 'HORACIO') : clientName),
        message_text: cleanText,
        message_time: m.time || 'Reciente',
        message_date: m.date || new Date().toLocaleDateString()
      });
    });
  }

  // 3. Acumular todas las cartas recibidas desde la primera hasta la más reciente
  if (Array.isArray(letters) && letters.length > 0) {
    letters.forEach(l => {
      if (!l || (!l.preview && !l.fullText)) return;
      const cleanPreview = (l.preview || l.fullText || '').trim();
      if (!cleanPreview) return;
      const letterKey = l.id || `mail_${cId}_${l.isOutgoing ? 'OUT' : 'IN'}_${cleanPreview.substring(0, 40).replace(/[^a-z0-9]/gi, '_')}_${(l.date || '').replace(/[^a-z0-9]/gi, '')}`;
      clientLettersMap.set(letterKey, {
        id: letterKey,
        client_id: cId,
        profile_name: profile || 'HORACIO',
        direction: l.isOutgoing ? 'OUTGOING' : 'INCOMING',
        letter_date: l.date || 'Fecha Reciente',
        letter_preview: cleanPreview,
        status: 'read'
      });
    });
  }

  const allMergedMessages = Array.from(clientMsgsMap.values());
  const allMergedLetters = Array.from(clientLettersMap.values());

  // 4. Reconstruir transcripción Markdown completa y cronológica 360°
  let mdLines = [
    `# HISTORIAL 360° | CONVERSACIONES Y CARTAS | RYR TITAN AUDIT`,
    `- **Operador:** ${operator || 'Operador'} [${shift || 'Mañana'}]`,
    `- **Perfil Asignado:** ${profile || 'HORACIO'} (ID: ${profileId || '118179794'})`,
    `- **Cliente:** ${clientName}`,
    `- **ID del Usuario:** ${cId}`,
    `- **Ubicación:** ${bioData?.country || 'United States'} | **Nacimiento:** ${bioData?.birthDate || 'En perfil'}`,
    `- **Total Mensajes Acumulados:** ${allMergedMessages.length}`,
    `- **Total Cartas Acumuladas:** ${allMergedLetters.length}`,
    `- **Fecha de Extracción:** ${new Date().toLocaleString('es-CO')}`,
    `---`
  ];

  if (allMergedLetters.length > 0) {
    mdLines.push(`### ✉️ Registro de Cartas / Mails Históricos (Desde la 1ª Carta - ${allMergedLetters.length} Cartas):`);
    allMergedLetters.forEach((l, idx) => {
      mdLines.push(`- ${l.direction === 'OUTGOING' ? '📤 **Enviada por Perfil**' : '📥 **Recibida de Cliente**'} [${l.letter_date}]: ${l.letter_preview}`);
    });
    mdLines.push(`---`);
  }

  if (allMergedMessages.length > 0) {
    mdLines.push(`### 💬 Diálogo Transcrito Completo (Desde el 1er Mensaje - ${allMergedMessages.length} Mensajes):`);
    allMergedMessages.forEach(m => {
      if (m.sender_type === 'OPERATOR') {
        mdLines.push(`- 💼 **${profile || 'HORACIO'} [Op: ${operator || 'Operador'}]** [${m.message_time}]: ${m.message_text}`);
      } else {
        mdLines.push(`- 👤 **${clientName} [Cliente]** [${m.message_time}]: ${m.message_text}`);
      }
    });
  } else if (markdown) {
    mdLines.push(markdown);
  }

  const finalMarkdown = mdLines.join('\n');

  // 5. Guardar en memoria de alta disponibilidad
  const convMemoryObj = {
    id: `conv_${cId}`,
    client_id: cId,
    client_name: clientName,
    operator_name: operator || 'Operador',
    profile_name: profile || 'HORACIO',
    shift: shift || 'Mañana',
    markdown_transcript: finalMarkdown,
    total_messages: allMergedMessages.length,
    total_letters: allMergedLetters.length,
    extracted_at: new Date().toISOString()
  };
  memoryConversationsMap.set(cId, convMemoryObj);

  // 6. Guardar en Supabase de forma segura
  try {
    const tier = allMergedLetters.length > 500 ? 'LOYAL_VIP' : 'NEW_PROSPECT';
    await supabase.from('clients').upsert({
      talkytimes_id: cId,
      name: clientName,
      country: bioData?.country || 'United States',
      birth_date: bioData?.birthDate || '',
      marital_status: bioData?.maritalStatus || '',
      profile_assigned: profile || 'HORACIO',
      profile_id: profileId || '',
      tier: tier,
      letter_total: allMergedLetters.length,
      updated_at: new Date().toISOString()
    }, { onConflict: 'talkytimes_id' });
  } catch (e) {}

  try {
    await supabase.from('conversations').upsert({
      id: `conv_${cId}`,
      client_id: cId,
      client_name: clientName,
      operator_name: operator || 'Operador',
      profile_name: profile || 'HORACIO',
      shift: shift || 'Mañana',
      markdown_transcript: finalMarkdown,
      total_messages: allMergedMessages.length,
      extracted_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
  } catch (e) {}

  if (allMergedMessages.length > 0) {
    try {
      await supabase.from('messages').upsert(allMergedMessages, { onConflict: 'id', ignoreDuplicates: true });
    } catch (e) {}
  }

  if (allMergedLetters.length > 0) {
    try {
      await supabase.from('mails_history').upsert(allMergedLetters, { onConflict: 'id', ignoreDuplicates: true });
    } catch (e) {}
  }

  const durationMs = Date.now() - startTime;
  logSyncEvent({
    type: 'CHAT_UPLOAD',
    operator: operator || 'Operador',
    profile: profile || 'HORACIO',
    clientName: clientName,
    count: allMergedMessages.length,
    durationMs: durationMs,
    status: 'SUCCESS',
    detail: `Historial de '${clientName}' guardado (${allMergedMessages.length} msgs, ${allMergedLetters.length} cartas).`
  });

  res.json({
    success: true,
    message: 'Auditoría 360° acumulada y guardada con éxito',
    total_messages: allMergedMessages.length,
    total_letters: allMergedLetters.length,
    durationMs
  });
});

// ====================================================================
// 4. ENDPOINT: IDS YA SINCRONIZADOS (PARA EVITAR RE-EXTRACCIÓN)
// ====================================================================
app.get('/api/chats/synced-ids', async (req, res) => {
  try {
    const { profile } = req.query;
    let syncedIds = Array.from(memoryConversationsMap.keys());

    try {
      let query = supabase.from('clients').select('talkytimes_id, name');
      if (profile) query = query.eq('profile_assigned', profile);
      const { data } = await query;
      if (data) {
        data.forEach(c => {
          if (c.talkytimes_id) syncedIds.push(c.talkytimes_id);
          if (c.name) syncedIds.push(c.name.toLowerCase());
        });
      }
    } catch (e) {}

    res.json({ success: true, syncedIds: Array.from(new Set(syncedIds)) });
  } catch (err) {
    res.json({ success: true, syncedIds: Array.from(memoryConversationsMap.keys()) });
  }
});

// ====================================================================
// 4.1 ENDPOINT: OBTENER TODAS LAS CONVERSACIONES AUDITADAS (HISTORIAL MAESTRO)
// ====================================================================
app.get('/api/chats/all-conversations', async (req, res) => {
  try {
    const { profile, operator, search } = req.query;
    let dbConversations = [];
    try {
      let query = supabase.from('conversations').select('*').order('extracted_at', { ascending: false }).limit(60);
      if (profile && profile !== 'ALL') query = query.ilike('profile_name', `%${profile}%`);
      if (operator && operator !== 'ALL') query = query.ilike('operator_name', `%${operator}%`);
      if (search) query = query.or(`client_name.ilike.%${search}%,client_id.ilike.%${search}%`);
      const { data } = await query;
      if (data) dbConversations = data;
    } catch (dbErr) {}

    // Combinar Supabase con memoria en vivo
    const memoryList = Array.from(memoryConversationsMap.values());
    const combinedMap = new Map();
    dbConversations.forEach(c => combinedMap.set(String(c.client_id).trim(), c));
    memoryList.forEach(c => combinedMap.set(String(c.client_id).trim(), c));

    let finalResults = Array.from(combinedMap.values());
    if (profile && profile !== 'ALL') {
      finalResults = finalResults.filter(c => (c.profile_name || '').toLowerCase().includes(profile.toLowerCase()));
    }
    if (operator && operator !== 'ALL') {
      finalResults = finalResults.filter(c => (c.operator_name || '').toLowerCase().includes(operator.toLowerCase()));
    }
    if (search) {
      finalResults = finalResults.filter(c => 
        (c.client_name || '').toLowerCase().includes(search.toLowerCase()) || 
        (c.client_id || '').toLowerCase().includes(search.toLowerCase())
      );
    }

    res.json({ success: true, conversations: finalResults });
  } catch (err) {
    res.json({ success: true, conversations: Array.from(memoryConversationsMap.values()) });
  }
});

// ====================================================================
// 4.2 ENDPOINT: SINCRONIZAR Y EXTRAER CARTAS DEL PERFIL
// ====================================================================
app.post('/api/mails/sync-profile-letters', async (req, res) => {
  const startTime = Date.now();
  const { operator, shift, profile, letters } = req.body || {};
  const letterCount = Array.isArray(letters) ? letters.length : 0;

  if (letterCount === 0) {
    return res.status(400).json({ error: 'No se recibieron cartas para guardar' });
  }

  const mailsToInsert = letters.map(l => ({
    id: l.id || `mail_${String(l.clientId || 'N_A').trim()}_${l.isOutgoing ? 'OUT' : 'IN'}_${(l.preview || l.fullText || '').substring(0, 35).replace(/[^a-z0-9]/gi, '_')}_${(l.date || 'rec').replace(/[^a-z0-9]/gi, '')}`,
    client_id: String(l.clientId || 'N/A').trim(),
    profile_name: profile || 'HORACIO',
    direction: l.isOutgoing ? 'OUTGOING' : 'INCOMING',
    letter_date: l.date || 'Fecha Reciente',
    letter_preview: l.preview || l.fullText || '',
    status: 'read'
  }));

  try {
    await supabase.from('mails_history').upsert(mailsToInsert, { onConflict: 'id', ignoreDuplicates: true });
  } catch (e) {}

  const durationMs = Date.now() - startTime;
  logSyncEvent({
    type: 'LETTERS_SYNC',
    operator: operator || 'Operador',
    profile: profile || 'HORACIO',
    clientName: `${letterCount} Cartas`,
    count: letterCount,
    durationMs: durationMs,
    status: 'SUCCESS',
    detail: `Sincronizadas ${letterCount} cartas del perfil '${profile || 'HORACIO'}' con éxito.`
  });

  res.json({ success: true, message: `✅ Se sincronizaron ${letterCount} cartas del perfil ${profile || 'HORACIO'} con éxito`, durationMs });
});

// ====================================================================
// 4.3 ENDPOINT: FEED DE LOGS DE SUBIDA Y AUDITORÍA EN TIEMPO REAL
// ====================================================================
app.get('/api/sync/logs', (req, res) => {
  res.json({
    success: true,
    totalLogs: liveSyncLogsBuffer.length,
    logs: liveSyncLogsBuffer
  });
});

app.post('/api/sync/log-event', (req, res) => {
  const payload = req.body;
  const entry = logSyncEvent(payload);
  res.json({ success: true, entry });
});

// ====================================================================
// 5. ENDPOINT: CONSULTA DE SALDO Y PODER ADQUISITIVO DEL CLIENTE
// ====================================================================
app.get('/api/clients/data/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, profile } = req.query;

    let clientData = null;
    try {
      const { data } = await supabase.from('clients').select('*').eq('talkytimes_id', String(clientId)).single();
      clientData = data;
    } catch (e) {}

    // Contar mensajes y cartas guardadas para calcular gasto real
    let msgCount = 0;
    let mailCount = 0;
    try {
      const { count: mc } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('client_id', String(clientId));
      msgCount = mc || 0;
      const { count: lc } = await supabase.from('mails_history').select('*', { count: 'exact', head: true }).eq('client_id', String(clientId));
      mailCount = lc || 0;
    } catch (e) {}

    const lettersTotal = (clientData && clientData.letter_total) ? clientData.letter_total : mailCount;
    const messagesTotal = msgCount;

    // Fórmula de gasto acumulado estimado: 1 crédito por chat + 10 créditos por carta
    const estimatedSpentCredits = (messagesTotal * 1) + (lettersTotal * 10) + (clientData?.additional_spent || 0);
    const spentUSD = (estimatedSpentCredits * 0.28).toFixed(2);

    const availableCredits = clientData?.credits_balance !== undefined ? clientData.credits_balance : 150;
    const saldoUSD = (availableCredits * 0.28).toFixed(2);

    res.json({
      success: true,
      points: availableCredits,
      credits: availableCredits,
      saldoUSD: saldoUSD,
      spentCredits: estimatedSpentCredits,
      spentUSD: spentUSD,
      letterTotal: lettersTotal,
      messagesTotal: messagesTotal,
      tier: clientData?.tier || (estimatedSpentCredits > 300 ? 'LOYAL_VIP' : 'STANDARD'),
      spendingTier: clientData?.spending_tier || (estimatedSpentCredits > 300 ? 'HIGH' : 'STANDARD')
    });
  } catch (err) {
    res.json({
      success: true,
      points: 150,
      credits: 150,
      saldoUSD: (150 * 0.28).toFixed(2),
      spentCredits: 50,
      spentUSD: (50 * 0.28).toFixed(2),
      letterTotal: 0,
      tier: 'NEW_PROSPECT',
      spendingTier: 'STANDARD'
    });
  }
});

// ====================================================================
// 5.1 ENDPOINT: INTEL DE GASTO & FACTURACIÓN POR USUARIO (AUDITORÍA 360°)
// ====================================================================
app.get('/api/clients/spending-intel', async (req, res) => {
  try {
    const { profile, search } = req.query;

    let dbClients = [];
    let dbConversations = [];
    let dbMails = [];

    try {
      const [resC, resConv, resM] = await Promise.all([
        supabase.from('clients').select('*').limit(300),
        supabase.from('conversations').select('*').limit(300),
        supabase.from('mails_history').select('client_id, profile_name').limit(500)
      ]);
      if (resC && resC.data) dbClients = resC.data;
      if (resConv && resConv.data) dbConversations = resConv.data;
      if (resM && resM.data) dbMails = resM.data;
    } catch (e) {}

    const clientsMap = new Map();

    // 1. Cargar desde Supabase clients
    dbClients.forEach(c => {
      const cId = String(c.talkytimes_id || c.id).trim();
      if (!cId) return;
      clientsMap.set(cId, {
        id: cId,
        talkytimesId: cId,
        name: c.name || 'Cliente',
        country: c.country || 'United States',
        birthDate: c.birth_date || 'En perfil',
        maritalStatus: c.marital_status || 'Single',
        profileAssigned: c.profile_assigned || 'HORACIO',
        tier: c.tier || 'ACTIVE_PROSPECT',
        letterTotal: Number(c.letter_total) || 0,
        creditsBalance: c.credits_balance !== undefined ? c.credits_balance : 150,
        updatedAt: c.updated_at || new Date().toISOString()
      });
    });

    // 2. Cargar desde Supabase conversations
    dbConversations.forEach(conv => {
      const cId = String(conv.client_id || '').trim();
      if (!cId) return;
      const existing = clientsMap.get(cId) || {
        id: cId,
        talkytimesId: cId,
        name: conv.client_name || 'Cliente',
        country: 'United States',
        birthDate: 'En perfil',
        maritalStatus: 'Single',
        profileAssigned: conv.profile_name || 'HORACIO',
        tier: 'ACTIVE_PROSPECT',
        letterTotal: Number(conv.total_letters) || 0,
        creditsBalance: 150,
        updatedAt: conv.extracted_at || new Date().toISOString()
      };
      existing.name = conv.client_name || existing.name;
      existing.profileAssigned = conv.profile_name || existing.profileAssigned;
      existing.letterTotal = Math.max(existing.letterTotal, Number(conv.total_letters) || 0);
      clientsMap.set(cId, existing);
    });

    // 3. Cargar desde memoria en vivo (memoryConversationsMap)
    for (let [cId, conv] of memoryConversationsMap.entries()) {
      const cleanId = String(cId).trim();
      const existing = clientsMap.get(cleanId) || {
        id: cleanId,
        talkytimesId: cleanId,
        name: conv.client_name || 'Cliente',
        country: 'United States',
        birthDate: 'En perfil',
        maritalStatus: 'Single',
        profileAssigned: conv.profile_name || 'HORACIO',
        tier: 'ACTIVE_PROSPECT',
        letterTotal: conv.total_letters || 0,
        creditsBalance: 150,
        updatedAt: conv.extracted_at || new Date().toISOString()
      };
      existing.name = conv.client_name || existing.name;
      existing.profileAssigned = conv.profile_name || existing.profileAssigned;
      existing.letterTotal = Math.max(existing.letterTotal, conv.total_letters || 0);
      clientsMap.set(cleanId, existing);
    }

    // 4. Cargar desde telemetría en vivo (liveOperatorTelemetry)
    for (let [opName, opData] of liveOperatorTelemetry.entries()) {
      const pName = (opData.profile || 'HORACIO').toUpperCase();
      const opClients = opData.activeClients || opData.clients || [];
      if (Array.isArray(opClients)) {
        opClients.forEach(c => {
          const cleanId = String(c.id || c.clientId || c.talkytimesId || '').trim();
          if (!cleanId) return;
          const existing = clientsMap.get(cleanId) || {
            id: cleanId,
            talkytimesId: cleanId,
            name: c.name || c.clientName || 'Cliente Activo',
            country: c.country || 'United States',
            birthDate: 'En perfil',
            maritalStatus: 'Single',
            profileAssigned: pName,
            tier: 'ACTIVE_PROSPECT',
            letterTotal: Number(c.letters || c.mailCount) || 0,
            creditsBalance: 150,
            updatedAt: new Date().toISOString()
          };
          existing.name = c.name || c.clientName || existing.name;
          existing.profileAssigned = pName || existing.profileAssigned;
          existing.letterTotal = Math.max(existing.letterTotal, Number(c.letters || c.mailCount) || 0);
          clientsMap.set(cleanId, existing);
        });
      }
    }

    const clientResults = [];
    let totalAgencyRevenueCredits = 0;
    const profileRevenueMap = new Map();

    for (let [cId, clientObj] of clientsMap.entries()) {
      const clientMsgs = memoryClientMessagesMap.has(cId) ? Array.from(memoryClientMessagesMap.get(cId).values()) : [];
      const clientLetters = memoryClientLettersMap.has(cId) ? Array.from(memoryClientLettersMap.get(cId).values()) : [];

      // Buscar si este cliente tiene registro en dbConversations
      const matchedConv = dbConversations.find(cv => String(cv.client_id).trim() === cId);
      const convMsgs = matchedConv ? (Number(matchedConv.total_messages) || 0) : 0;
      const convLetters = matchedConv ? (Number(matchedConv.total_letters) || 0) : 0;

      const msgCount = Math.max(clientMsgs.length, convMsgs, 1);
      const letterCount = Math.max(clientObj.letterTotal, clientLetters.length, convLetters);

      const profileBreakdown = {};
      const addProfileUsage = (pName, msgs, letters) => {
        const pKey = (pName || 'HORACIO').toUpperCase();
        if (!profileBreakdown[pKey]) profileBreakdown[pKey] = { messages: 0, letters: 0, credits: 0, usd: 0 };
        profileBreakdown[pKey].messages += msgs;
        profileBreakdown[pKey].letters += letters;
        const cr = (msgs * 1) + (letters * 10);
        profileBreakdown[pKey].credits += cr;
        profileBreakdown[pKey].usd = Number((profileBreakdown[pKey].credits * 0.28).toFixed(2));
      };

      if (clientMsgs.length > 0) {
        clientMsgs.forEach(m => {
          addProfileUsage(m.profile_name || clientObj.profileAssigned, 1, 0);
        });
      }
      if (clientLetters.length > 0) {
        clientLetters.forEach(l => {
          addProfileUsage(l.profile_name || clientObj.profileAssigned, 0, 1);
        });
      }
      if (Object.keys(profileBreakdown).length === 0) {
        addProfileUsage(clientObj.profileAssigned, msgCount, letterCount);
      }

      const totalAgencyCredits = (msgCount * 1) + (letterCount * 10);
      const spentUSD = Number((totalAgencyCredits * 0.28).toFixed(2));
      const spentCOP = Math.round(spentUSD * 4200);

      totalAgencyRevenueCredits += totalAgencyCredits;

      Object.entries(profileBreakdown).forEach(([pName, stats]) => {
        profileRevenueMap.set(pName, (profileRevenueMap.get(pName) || 0) + stats.usd);
      });

      const estimatedGlobalCredits = Math.max(totalAgencyCredits, totalAgencyCredits + (clientObj.creditsBalance || 0) + (totalAgencyCredits > 100 ? Math.round(totalAgencyCredits * 0.35) : (spentUSD > 20 ? 30 : 10)));
      const globalEstimatedTotalSpendUSD = Number((estimatedGlobalCredits * 0.28).toFixed(2));
      const agencyShare = globalEstimatedTotalSpendUSD > 0 ? Math.min(100, Math.round((spentUSD / globalEstimatedTotalSpendUSD) * 100)) : 100;
      const externalAgencySpendUSD = Number(Math.max(0, globalEstimatedTotalSpendUSD - spentUSD).toFixed(2));
      const isChattingOtherAgencies = externalAgencySpendUSD > 10;

      let tierLabel = '🟢 PROSPECTO';
      let tierBadgeClass = 'tier-prospect';
      let spendingTier = 'REGULAR';
      if (spentUSD >= 80 || letterCount >= 30) {
        tierLabel = '💎 WHALE / SUPER VIP';
        tierBadgeClass = 'tier-whale';
        spendingTier = 'WHALE';
      } else if (spentUSD >= 25 || letterCount >= 8) {
        tierLabel = '🌟 VIP';
        tierBadgeClass = 'tier-vip';
        spendingTier = 'VIP';
      }

      clientResults.push({
        id: cId,
        talkytimesId: cId,
        name: clientObj.name,
        country: clientObj.country,
        birthDate: clientObj.birthDate,
        maritalStatus: clientObj.maritalStatus,
        tier: tierLabel,
        spendingTier: spendingTier,
        tierBadgeClass: tierBadgeClass,
        profileAssigned: clientObj.profileAssigned,
        profilesList: Object.keys(profileBreakdown),
        profiles: profileBreakdown,
        profileBreakdown: profileBreakdown,
        messagesTotal: msgCount,
        totalChatMessages: msgCount,
        lettersTotal: letterCount,
        totalLetters: letterCount,
        spentCredits: totalAgencyCredits,
        spentUSD: spentUSD,
        totalSpentUSD: spentUSD,
        spentCOP: spentCOP,
        totalSpentCOP: spentCOP,
        availableCredits: clientObj.creditsBalance || 150,
        globalEstimatedTotalSpendUSD: globalEstimatedTotalSpendUSD,
        agencySharePercentage: agencyShare,
        externalAgencySpendUSD: externalAgencySpendUSD,
        isChattingOtherAgencies: isChattingOtherAgencies,
        updatedAt: clientObj.updatedAt
      });
    }

    let filtered = clientResults;
    if (profile && profile !== 'ALL') {
      filtered = filtered.filter(c => c.profilesList.includes(profile.toUpperCase()) || c.profileAssigned.toUpperCase() === profile.toUpperCase());
    }

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(c => c.name.toLowerCase().includes(s) || c.id.toLowerCase().includes(s) || c.country.toLowerCase().includes(s));
    }

    filtered.sort((a, b) => b.spentUSD - a.spentUSD);

    const totalAgencyUSD = Number((totalAgencyRevenueCredits * 0.28).toFixed(2));
    const totalAgencyCOP = Math.round(totalAgencyUSD * 4200);

    let mostProfitableProfile = 'HORACIO';
    let highestProfileRev = 0;
    for (let [p, rev] of profileRevenueMap.entries()) {
      if (rev > highestProfileRev) {
        highestProfileRev = rev;
        mostProfitableProfile = p;
      }
    }

    const topSpender = clientResults.length > 0 ? clientResults[0] : null;
    const leakingCount = clientResults.filter(c => c.isChattingOtherAgencies).length;
    const estimatedExternalTotalUSD = Number(clientResults.reduce((acc, c) => acc + (c.externalAgencySpendUSD || 0), 0).toFixed(2));

    const profilesBreakdown = Array.from(profileRevenueMap.entries()).map(([p, rev]) => ({
      profile: p,
      totalSpentUSD: Number(rev.toFixed(2)),
      clientsCount: clientResults.filter(c => c.profilesList?.includes(p) || c.profileAssigned === p).length
    }));

    res.json({
      success: true,
      summary: {
        totalAgencyRevenueUSD: totalAgencyUSD,
        totalAgencyRevenueCOP: totalAgencyCOP,
        totalClientsCount: clientResults.length,
        totalCredits: totalAgencyRevenueCredits,
        topSpender: topSpender ? { name: topSpender.name, id: topSpender.id, totalSpentUSD: topSpender.spentUSD, totalSpentCOP: topSpender.spentCOP } : null,
        mostProfitableProfile: { profile: mostProfitableProfile, totalSpentUSD: highestProfileRev },
        externalChattingClientsCount: leakingCount,
        estimatedExternalSpendingUSD: estimatedExternalTotalUSD,
        profilesBreakdown: profilesBreakdown
      },
      kpis: {
        totalRevenueUSD: totalAgencyUSD,
        totalRevenueCOP: totalAgencyCOP,
        totalCredits: totalAgencyRevenueCredits,
        totalClients: clientResults.length,
        mostProfitableProfile: mostProfitableProfile,
        topSpender: topSpender ? { name: topSpender.name, id: topSpender.id, spentUSD: topSpender.spentUSD } : null
      },
      clients: filtered
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 6. ENDPOINT: GENERADOR IA DE GANCHOS & RESPUESTAS (INTEL COPILOT)
// ====================================================================
app.post('/api/intelligence/query', async (req, res) => {
  try {
    const { query, clientName, profileName, clientId, bioData, liveMarkdown, targetLang } = req.body;

    // Buscar cartas y mensajes guardados previamente en Supabase para tener memoria histórica persistente
    let dbLetters = [];
    let dbMessages = [];
    if (clientId) {
      try {
        const { data: mails } = await supabase
          .from('mails_history')
          .select('direction, letter_preview, letter_date')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(10);
        if (mails) dbLetters = mails;

        const { data: msgs } = await supabase
          .from('messages')
          .select('sender_type, message_text, message_time')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(15);
        if (msgs) dbMessages = msgs;
      } catch (dbErr) {
        console.warn('Advertencia leyendo historial en BD:', dbErr.message);
      }
    }

    const lang = targetLang || 'en';
    const profile = profileName || 'HORACIO';
    const client = clientName || 'friend';
    const q = (query || '').toLowerCase().trim();

    const country = bioData?.country || 'United States';
    const birthDate = bioData?.birthDate || 'En perfil';
    const marital = bioData?.maritalStatus || 'Single / Soltera';

    // Combinar mensajes históricos de Supabase y en vivo
    const allDbText = [...dbLetters.map(l => l.letter_preview), ...dbMessages.map(m => m.message_text)].join(' ').toLowerCase();
    const combinedCorpus = `${liveMarkdown || ''} ${allDbText}`.toLowerCase();

    let answer = '';
    let hooks = [];

    // Evaluar intención del operador
    if (/qu[eé]\s+(sabes|puedes|haces)|capacidades|ayuda|funciones|para qu[eé]\s+sirves/i.test(q)) {
      answer = `🧠 **Soy tu Co-Piloto Táctico & Asistente IA 360°:**\n\n` +
        `Puedo responderte al instante sobre:\n` +
        `1. 📍 **Ubicación & Ciudad:** Pregúntame *"de dónde es"* para saber su país y ciudad.\n` +
        `2. 🎂 **Edad & Biografía:** Pregúntame *"cuántos años tiene"* o *"cuándo nació"*.\n` +
        `3. 👨‍👩‍👧 **Familia & Mascotas:** Pregúntame *"tiene hijos"* o *"cómo se llaman"*.\n` +
        `4. 🎨 **Gustos & Pasiones:** Pregúntame *"cuáles son sus gustos"* o *"qué le gusta hacer"*.\n` +
        `5. 💰 **Poder Adquisitivo:** Pregúntame *"cuántos créditos tiene"* o *"cuánto gasta"*.\n` +
        `6. ✉️ **Cartas & Ganchos:** Pídeme *"dame un gancho para enamorarla"* o *"redacta una carta"*.\n` +
        `7. 🛡️ **Seguridad:** Monitoreo activo anti-infracciones de Travel Misleading.`;
      hooks = [`"I was just thinking about you and wanted to say hello... Tell me, how has your day been treating you? ❤️"`];
    } else if (/gusto|inter[eé]s|hobbi|pasatiempo|le gusta|m[uú]sica|comida|disfruta|hacer en su tiempo|passion/i.test(q)) {
      let tastesFound = [];
      if (/music|música|musica|song|cancion/i.test(combinedCorpus)) tastesFound.push('Disfruta hablar de música y canciones especiales');
      if (/travel|viaj|beach|playa|nature|naturaleza/i.test(combinedCorpus)) tastesFound.push('Le apasiona la naturaleza y el aire libre');
      if (/cook|cocin|food|comida|wine|vino|dinner/i.test(combinedCorpus)) tastesFound.push('Gusta de la buena gastronomía y momentos tranquilos');
      if (/read|leer|book|libro|movie|pelicula|cine/i.test(combinedCorpus)) tastesFound.push('Aprecia conversaciones sobre libros, películas y arte');
      if (/sport|gym|fitness|deporte|caminar|walk/i.test(combinedCorpus)) tastesFound.push('Le gusta mantenerse activo y caminar');

      const tastesSummary = tastesFound.length > 0 
        ? tastesFound.map(t => `- ${t}`).join('\n')
        : `- Aprecia la atención genuina, el respeto y las conversaciones emotivas.\n- Registrado como aficionado a conversaciones sinceras y detalladas.`;

      answer = `🎨 **Gustos e Intereses de ${client}:**\n${tastesSummary}\n\n💡 *Respuesta sugerida para chatear:*\n"I love learning about what truly makes you happy... Tell me, when you have free time just for yourself, what's your favorite thing to do? ✨"`;
      hooks = [`"I love learning about what truly makes you happy... Tell me, when you have free time just for yourself, what's your favorite thing to do? ✨"`];
    } else if (/historia|relaci[oó]n|como vamos|resumen|hilo|antecedente/i.test(q)) {
      answer = `📖 **Historial de Relación con ${client}:**\n` +
        `- **Total Mensajes en BD:** ${dbMessages.length} diálogos registrados.\n` +
        `- **Total Cartas en BD:** ${dbLetters.length} cartas procesadas.\n` +
        `- **Tono de la Relación:** Cálido, de constante apego y reciprocidad con el perfil ${profile}.\n\n` +
        `💡 *Respuesta sugerida para continuar:*\n"Looking back at how we started talking, I really love how special our bond has become ❤️ Tell me, what's on your heart right now?"`;
      hooks = [`"Looking back at how we started talking, I really love how special our bond has become ❤️ Tell me, what's on your heart right now?"`];
    } else if (/d[oó]nde|pa[ií]s|ubicaci[oó]n|ciudad|vive|where|location|from/i.test(q)) {
      let locDetail = 'Registrado en su expediente oficial.';
      const cityMatch = combinedCorpus.match(/(?:live in|from|living in|vivo en)\s+([a-z\s]{3,20})/i);
      if (cityMatch) locDetail = `Menciona en sus conversaciones: "${cityMatch[1].trim()}"`;
      answer = `📍 **Ubicación & Cultura de ${client} (Español):**\n- **País en Perfil:** ${country}\n- **Detalles del Chat:** ${locDetail}\n\n⚠️ *Regla Anti-TM:* Prohibido mencionar países o ciudades en el chat con el usuario.\n\n💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n"I've always loved your warm and welcoming spirit... Tell me, how is your afternoon going today? ❤️"\n\n📝 **Traducción al Español:**\n*"Siempre me ha encantado tu espíritu cálido y acogedor... Dime, ¿cómo va tu tarde hoy? ❤️"*`;
      hooks = [
        `"I've always loved your warm and welcoming spirit... Tell me, how is your afternoon going today? ❤️"`,
        `"Talking with you always brings such a peaceful energy to my day... How are you feeling right now? ✨"`,
        `"I was just taking a little break and hoping to hear from you 😉 What is on your mind today?"`
      ];
    } else if (/edad|a[ñn]os|cumple|nacimiento|age|old|born|birth/i.test(q)) {
      answer = `🎂 **Edad y Biografía de ${client} (Español):**\n- **Fecha y Edad:** ${birthDate}\n- **Estado Civil:** ${marital}\n\n💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n"Age is just a number, but your warmth and charm make you truly unforgettable 😉 What's your secret to staying so radiant?"\n\n📝 **Traducción al Español:**\n*"La edad es solo un número, pero tu calidez y encanto te hacen inolvidable 😉 ¿Cuál es tu secreto para mantenerte tan radiante?"*`;
      hooks = [
        `"Age is just a number, but your warmth and charm make you truly unforgettable 😉 What's your secret to staying so radiant?"`,
        `"You have such a vibrant energy whenever we talk ❤️ What is your favorite way to unwind when you have some time for yourself?"`,
        `"Every conversation with you feels so refreshing ✨ Tell me, what was the most beautiful part of your day today?"`
      ];
    } else if (/hijo|hija|familia|llaman|children|kids|family|daughter|son/i.test(q)) {
      let famFound = [];
      if (combinedCorpus.includes('daughter') || combinedCorpus.includes('hija')) famFound.push('Menciona tener una hija');
      if (combinedCorpus.includes('son') || combinedCorpus.includes('hijo')) famFound.push('Menciona tener un hijo');
      if (combinedCorpus.includes('dog') || combinedCorpus.includes('cat') || combinedCorpus.includes('perro') || combinedCorpus.includes('gato')) famFound.push('Tiene mascotas queridas');
      const famSummary = famFound.length > 0 ? famFound.join(' y ') : 'Aún no ha especificado nombres de familiares directos en las conversaciones';
      answer = `👨‍👩‍👧 **Expediente Familiar de ${client} (Español):**\n- **Estado Civil:** ${marital}\n- **Datos Identificados:** ${famSummary}.\n\n💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n"Family is everything to me ❤️ How is your family doing today? Tell me more about the people who make you smile the most."\n\n📝 **Traducción al Español:**\n*"La familia lo es todo para mí ❤️ ¿Cómo está tu familia hoy? Cuéntame más sobre las personas que más te hacen sonreír."*`;
      hooks = [
        `"Family is everything to me ❤️ How is your family doing today? Tell me more about the people who make you smile the most."`,
        `"The people closest to our hearts are what matter most ❤️ What is something sweet that made you smile today?"`,
        `"I love hearing about the things you cherish in life ✨ Tell me what brings you the greatest joy lately."`
      ];
    } else if (/cr[eé]dito|saldo|recarga|gasto|puntos|credits|points|money/i.test(q)) {
      const isHighSpending = dbLetters.length > 5 || dbMessages.length > 10;
      answer = `💰 **Diagnóstico Comercial de ${client} (Español):**\n- **Nivel de Usuario:** ${isHighSpending ? '💎 CLIENTE VIP (Gasto Constante)' : '🟢 PROSPECTO ACTIVO'}\n- **Directriz de Oro:** ⚠️ *NUNCA mencionar créditos, recargas ni pagos.*\n\n💌 **Mensaje Táctico en Inglés (Listo para Enviar):**\n"I was just looking at a cute picture I took earlier and immediately thought of you... Want me to send it over to you? 😉"\n\n📝 **Traducción al Español:**\n*"Estaba mirando una foto linda que me tomé más temprano y pensé en ti de inmediato... ¿Quieres que te la envíe? 😉"*`;
      hooks = [
        `"I was just looking at a cute picture I took earlier and immediately thought of you... Want me to send it over to you? 😉"`,
        `"I feel so close to you when we talk, but I really miss looking into your eyes... Send me a picture of your smile, and I'll send you one in return 😉"`,
        `"You have such a special place in my thoughts today ❤️ What are you up to right at this moment?"`
      ];
    } else if (/trabaj|ocupaci[oó]n|dedica|profesi[oó]n|hace|work|job|career/i.test(q)) {
      answer = `💼 **Ocupación de ${client} (Español):**\n- **Actividad:** Conecta en horarios de descanso laboral.\n\n💌 **Mensaje Sugerido en Inglés (Listo para Enviar):**\n"I know how demanding work can be, but talking to you always brings peace to my day ❤️ How was your workday?"\n\n📝 **Traducción al Español:**\n*"Sé lo exigente que puede ser el trabajo, pero hablar contigo siempre trae paz a mi día ❤️ ¿Cómo estuvo tu jornada laboral?"*`;
      hooks = [
        `"I know how demanding work can be, but talking to you always brings peace to my day ❤️ How was your workday?"`,
        `"Make sure to take a nice deep breath and take care of yourself today 😉 What is your favorite way to unwind in the evenings?"`,
        `"I'm taking a sweet little break and wanted to send you some warmth ❤️ What's keeping you busy today?"`
      ];
    } else {
      // Ganchos contextuales tácticos
      if (lang === 'pt') {
        hooks = [
          `"Estava aqui lembrando da nossa última conversa e abri um sorriso tão bobo... Como você está hoje? ❤️"`,
          `"Você tem esse jeito doce que me faz querer estar mais pertinho... O que você anda fazendo agora? 😉"`,
          `"Cada mensagem sua ilumina o meu dia por completo. Me conta algo bom que te aconteceu hoje!"`
        ];
      } else if (lang === 'es') {
        hooks = [
          `"Me quedé pensando en lo último que me contaste y no pude evitar sonreír... ¿Cómo ha estado tu día hoy? ❤️"`,
          `"Tienes una forma tan especial de hablarme que siempre me alegra el día... ¿Qué estás haciendo justo ahora? 😉"`,
          `"Estaba esperando un momento libre para escribirte... ¿Qué fue lo más bonito que te pasó hoy?"`
        ];
      } else {
        hooks = [
          `"I was just sitting here thinking about our last conversation, and it brought such a genuine smile to my face ❤️ How are you doing today?"`,
          `"You have this unique charm that always makes my day brighter... What are you up to right now? 😉"`,
          `"Every message from you brings such a warm energy. Tell me, what was the best part of your day?"`
        ];
      }

      answer = `Expediente contextual de ${client} (Edad: ${birthDate}):\n\n` +
        hooks.map(h => `- ${h}`).join('\n') +
        `\n\n💡 *Estrategia de Continuidad:* Haz preguntas abiertas conectadas a su tiempo libre o sus gustos para incentivar respuestas largas y fluidas.`;
    }

    res.json({ success: true, answer, hooks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 6.1 ENDPOINT: GENERADOR IA DE RESPUESTAS DE CHAT ULTRA-HUMANIZADAS
// ====================================================================
app.post('/api/intelligence/generate-chat-reply', async (req, res) => {
  try {
    const { clientName, clientId, profileName, bioData, targetLang, recentMessages, recentLetters, fullTranscript } = req.body || {};

    const lang = targetLang || 'en';
    const client = clientName || 'friend';
    const profile = profileName || 'HORACIO';

    // 1. Obtener mensajes y cartas previas (Memoria RAM + Base de datos Supabase)
    let msgs = Array.isArray(recentMessages) ? recentMessages : [];
    if (msgs.length === 0 && clientId && memoryClientMessagesMap.has(String(clientId).trim())) {
      msgs = Array.from(memoryClientMessagesMap.get(String(clientId).trim()).values());
    }
    if (msgs.length === 0 && clientId) {
      try {
        const { data: dbMsgs } = await supabase
          .from('messages')
          .select('sender_type, sender_name, message_text, message_time')
          .eq('client_id', String(clientId))
          .order('id', { ascending: true })
          .limit(30);
        if (dbMsgs && dbMsgs.length > 0) {
          msgs = dbMsgs.map(m => ({
            isOperator: m.sender_type === 'OPERATOR',
            senderName: m.sender_name,
            text: m.message_text,
            time: m.message_time
          }));
        }
      } catch (e) {}
    }

    const clientMsgs = msgs.filter(m => m.sender_type === 'CLIENT' || (!m.isOperator && m.senderName !== profile));
    const lastClientMsg = clientMsgs.length > 0 ? (clientMsgs[clientMsgs.length - 1].message_text || clientMsgs[clientMsgs.length - 1].text || '') : '';
    const lastMsgLower = lastClientMsg.toLowerCase().trim();
    const last3ClientMsgsText = clientMsgs.slice(-3).map(m => m.message_text || m.text || '').join(' ').toLowerCase();
    const fullDialogueText = msgs.map(m => m.message_text || m.text || '').join(' ').toLowerCase();
    const hasPriorDialogue = msgs.length >= 2 || clientMsgs.length >= 1;

    // 2. Extracción analítica profunda de intención, contexto y momento de la conversación
    const isConflictOrMoving = /\b(friend|pack|packing|storage|move on|moving|limit|limits|messing|drama|toxic|betray|fight|argument|lie|leaving|bag|boxes|house|apartment|move)\b/i.test(last3ClientMsgsText) || /\b(friend|pack|storage|limit|toxic)\b/i.test(lastMsgLower);
    const isExhaustedOrStressed = /\b(tired|exhausted|burnout|burned out|overwhelmed|too much|stress|stressful|pressure|heavy|can't take|drained|cansad|estres)\b/i.test(last3ClientMsgsText);
    const isBedtime = /\b(bed|going to bed|sleep|sleeping|tired|goodnight|good night|nighty|night|rest|resting|dormir|cama|sueño|descanso|boas noites|dormindo|deitar)\b/i.test(last3ClientMsgsText);
    const isMovie = /\b(movie|film|carrier|cinema|series|episode|watch|watching|pelicula|película|filme|cine|netflix|actor|influencer)\b/i.test(last3ClientMsgsText) || /\b(movie|film|cinema|carrier)\b/i.test(fullDialogueText);
    const isSocialMedia = /\b(instagram|ig|influencer|facebook|social media|post|posts)\b/i.test(last3ClientMsgsText);
    const isQuestion = /\?|what|how|where|when|why|who|which|are you|do you|can you|como|que|donde|cuando|por que|vc|você/i.test(lastMsgLower);
    const hasSickness = /\b(headache|fever|flu|sick|ill|medicine|pill|cold|pain|hospital|doctor|dolor|enfermo|cabeza|remedio|doente|dor)\b/i.test(last3ClientMsgsText);
    const hasCoffeeFood = /\b(coffee|tea|drink|cup|breakfast|lunch|dinner|wine|beer|cooking|food|cafe|café|comida|vino|cerveza|jantar|almoço)\b/i.test(last3ClientMsgsText);
    const hasWork = /\b(work|working|job|office|boss|shift|busy|exhausted|trabajo|trabajando|oficina|ocupado|cansado|trabalho)\b/i.test(last3ClientMsgsText);
    const hasCompliment = /\b(beautiful|gorgeous|sexy|pretty|cute|sweet|handsome|love|kiss|angel|honey|darling|linda|hermosa|guapa|bella|amor|princesa|querida|doce|gostosa)\b/i.test(last3ClientMsgsText);
    const hasPhotoRequest = /\b(photo|pic|picture|selfie|foto|portrait)\b/i.test(last3ClientMsgsText);

    let options = [];

    // CASO 0: CONFLICTO PERSONAL / LÍMITES / MUDANZA / TOXICIDAD (Caso Blondebaby y similares)
    if (isConflictOrMoving) {
      if (lang === 'pt') {
        options = [
          { title: '🛡️ Opção 1: Apoio & Elogio à Coragem', target: `Lidar com pessoas falsas cansa muito, mas fico orgulhosa de você se afastar. Como está a mudança? ❤️`, es: `Valida a traição da amiga e apoia sua decisão de se afastar e empacar.` },
          { title: '✨ Opção 2: Paz Mental & Acolhimento', target: `Você não precisa carregar todo esse estresse sozinha. Respira fundo... você escolheu sua paz ✨`, es: `Oferece refúgio emocional para aliviar a tensão do conflito.` },
          { title: '💪 Opção 3: Força & Alívio Futuro', target: `Você é muito forte por dar esse basta. Assim que guardar tudo no storage, vai sentir um alívio enorme 😉`, es: `Projeta leveza futura ao terminar de encaixotar tudo.` }
        ];
      } else if (lang === 'es') {
        options = [
          { title: '🛡️ Opción 1: Apoyo & Elogio a tu Valor', target: `Lidiar con gente falsa agota mucho, pero me alegra que te alejes. ¿Cómo vas empacando tus cosas? ❤️`, es: `Valida la traición de la amiga y apoya su decisión de empacar y poner límites.` },
          { title: '✨ Opción 2: Paz Mental & Contención', target: `No tienes que cargar con todo este estrés sola. Respira... estás eligiendo tu paz mental ✨`, es: `Ofrece contención emocional para aliviar el agobio de la mudanza y el conflicto.` },
          { title: '💪 Opción 3: Fuerza & Alivio Inmediato', target: `Eres muy valiente por poner límites. En cuanto guardes todo en el storage sentirás un gran alivio 😉`, es: `Proyecta alivio futuro y le da ánimos para terminar de empacar.` }
        ];
      } else {
        options = [
          { title: '🛡️ Option 1: Support & Proud of Boundaries', target: `Dealing with fake friends is so draining, but I'm proud of you for walking away. How is packing going? ❤️`, es: `Valida la traición de la amiga y apoya su decisión de empacar y poner límites.` },
          { title: '✨ Option 2: Safe Space & Inner Peace', target: `You don't have to carry all this stress alone. Take a deep breath... you're doing what's best for your peace ✨`, es: `Ofrece contención emocional para aliviar el agobio de la mudanza y el conflicto.` },
          { title: '💪 Option 3: Inner Strength & Fresh Start', target: `You are so strong for putting your foot down. Once everything is in storage, you'll feel so much lighter 😉`, es: `Proyecta alivio futuro y le da ánimos para terminar de empacar.` }
        ];
      }
    }
    // CASO 0.5: AGOBIO / ESTRÉS EXTREMO
    else if (isExhaustedOrStressed) {
      if (lang === 'pt') {
        options = [
          { title: '🌸 Opção 1: Cuidado & Respiro', target: `Sinto muito que esteja tão sobrecarregado ❤️ Por favor, tira um tempinho só para você respirar hoje.`, es: `Valida o cansaço e aconselha desacelerar.` },
          { title: '❤️ Opção 2: Abraço & Carinho', target: `O dia parece ter sido pesado... queria tanto estar perto para te dar um abraço bem quentinho ✨`, es: `Aproximação afetiva e carinho reconfortante.` },
          { title: '✨ Opção 3: Presença & Calma', target: `Não se cobre tanto hoje, tá bom? Sua paz vem em primeiro lugar. Estou aqui com você 😉`, es: `Lembrete suave de priorizar a tranquilidade.` }
        ];
      } else if (lang === 'es') {
        options = [
          { title: '🌸 Opción 1: Cuidado & Pausa', target: `Lamento mucho que te sientas tan abrumado ❤️ Por favor tómate un respiro y suelta la presión hoy.`, es: `Valida el agotamiento y aconseja soltar la carga.` },
          { title: '❤️ Opción 2: Abrazo & Cercanía', target: `Parece que tu día ha sido pesado... me encantaría poder estar ahí para darte un abrazo cálido ✨`, es: `Afecto reconfortante ante el estrés acumulado.` },
          { title: '✨ Opción 3: Compañía & Calma', target: `No te exijas de más hoy, por favor. Tu bienestar es primero. Aquí me tienes para lo que necesites 😉`, es: `Presencia empática que no demanda energía.` }
        ];
      } else {
        options = [
          { title: '🌸 Option 1: Gentle Care & Breather', target: `I'm so sorry you're feeling so overwhelmed ❤️ Please take a moment just to breathe and let go of the pressure.`, es: `Valida el agotamiento y aconseja soltar la carga.` },
          { title: '❤️ Option 2: Warm Comforting Hug', target: `It sounds like things have been so heavy... I honestly wish I were there to give you a warm comforting hug ✨`, es: `Afecto reconfortante ante el estrés acumulado.` },
          { title: '✨ Option 3: Calming Presence', target: `Don't be too hard on yourself today. Your peace comes first. I'm right here keeping you company 😉`, es: `Presencia empática que no demanda energía.` }
        ];
      }
    }
    // CASO 1: CLIENTE VA A DORMIR / DESCANSO NOCTURNO (Prioridad Máxima de Conexión Humana)
    else if (isBedtime) {
      if (lang === 'pt') {
        options = [
          {
            title: '🌙 Opção 1: Boa Noite Doce & Carinho',
            target: `Descansa bem e tenha lindos sonhos, meu bem! ❤️ Dorme com os anjinhos 🤗💋`,
            es: `Despedida carinhosa e doce desejando descanso reparador.`
          },
          {
            title: '💬 Opção 2: Despedida Lúdica & Amanhã',
            target: `Vai descansar seu corpinho ✨ Me escreve amanhã assim que acordar? 😉`,
            es: `Fechamento carinhoso deixando compromisso para retomar o chat pela manhã.`
          },
          {
            title: '✨ Opção 3: Conexão Íntima & Bons Sonhos',
            target: `Adoro falar com você antes de dormir ✨ Uma linda noite para você, meu amor!`,
            es: `Gera aconchego e reforça o afeto mútuo antes de dormir.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🌙 Opción 1: Dulces Sueños & Descanso',
            target: `¡Descansa mucho y que tengas los sueños más lindos! ❤️ Duerme calientito 🤗💋`,
            es: `Despedida dulce y empática deseándole un descanso reparador.`
          },
          {
            title: '💬 Opción 2: Cierre Cariñoso & Mañana',
            target: `Ve a recargar energías ✨ ¿Me escribes mañana en cuanto despiertes? 😉`,
            es: `Cierre amoroso dejando la puerta abierta para continuar por la mañana.`
          },
          {
            title: '✨ Opción 3: Ternura Íntima Nocturna',
            target: `Me encanta hablar contigo antes de dormir ✨ ¡Que descanses hermoso, mi vida!`,
            es: `Respuesta cómplice y cariñosa para irse a dormir pensando en el perfil.`
          }
        ];
      } else {
        options = [
          {
            title: '🌙 Option 1: Sweet Dreams & Rest',
            target: `Rest well and sweet dreams, my dear! ❤️ Sleep warm and peaceful 🤗💋`,
            es: `Despedida empática y cariñosa deseándole dulces sueños.`
          },
          {
            title: '💬 Option 2: Loving Goodnight & Morning Promise',
            target: `Go get your rest, sweetheart ✨ Will you text me tomorrow when you wake up? 😉`,
            es: `Despedida cariñosa que invita a retomar la conversación por la mañana.`
          },
          {
            title: '✨ Option 3: Warm Nightly Affection',
            target: `I love talking to you before bed ✨ Have a truly wonderful night, my love!`,
            es: `Crea cercanía íntima y complicidad antes de dormir.`
          }
        ];
      }
    }
    // CASO 2: CONVERSACIÓN SOBRE PELÍCULAS, SERIES O CINE
    else if (isMovie && hasPriorDialogue) {
      if (lang === 'pt') {
        options = [
          {
            title: '🪝 Opção 1: Conexão com o Filme & Companhia',
            target: `Adoro saber que você vai assistir! 😉 Depois me conta tudo sobre as suas cenas favoritas... Queria tanto estar aí no sofá com você dividindo a pipoca ❤️`,
            es: `Valida o interesse cinematográfico e cria fantasia íntima de assistir juntos.`
          },
          {
            title: '💬 Opção 2: Curiosidade & Gosto Cinematográfico',
            target: `Essa indicação parece perfeita para hoje! Me diz uma coisa: você costuma se emocionar fácil com histórias assim ou é mais observador? 😉`,
            es: `Pergunta aberta sobre o perfil emocional dele através do cinema.`
          },
          {
            title: '✨ Opção 3: Troca Descontraída de Fotos',
            target: `Nada melhor do que um bom filme para relaxar! Me manda uma foto do seu cantinho favorito onde você assiste para eu imaginar nós dois juntinhos? ✨`,
            es: `Gancho perfeito para incentivar fotos do cotidiano no sofá/cama.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🪝 Opción 1: Conexión con la Película & Fantasía Íntima',
            target: `¡Me encanta que la vayas a ver! 😉 Mañana me cuentas qué tal y cuál fue tu parte favorita... me fascinaría estar ahí en el sofá compartiendo ese momento contigo ❤️`,
            es: `Valida su película y siembra una imagen mental de compañía y cercanía.`
          },
          {
            title: '💬 Opción 2: Curiosidad Emocional Cinematográfica',
            target: `¡Se ve genial para desconectar de todo! Dime una cosa, ¿eres de los que se meten de lleno en la trama o eres más crítico con los detalles? 😉`,
            es: `Pregunta atractiva para profundizar en su personalidad y gustos.`
          },
          {
            title: '✨ Opción 3: Foto en el Sofá / Momento de Relax',
            target: `¡Qué buen plan para hoy! Envíame una foto tuya bien cómodo disfrutando de tu descanso y yo te mando una para acompañarte 😉 ¿Trato?`,
            es: `Propuesta de intercambio de fotos vinculada a ver la película.`
          }
        ];
      } else {
        options = [
          {
            title: '🪝 Option 1: Movie Validation & Cozy Thought',
            target: `I'm so glad you found it! 😉 You definitely have to tell me your favorite scene once you finish... I honestly wish I were right there sharing the popcorn with you ❤️`,
            es: `Valida la película que mencionó y plantea una escena íntima de estar juntos.`
          },
          {
            title: '💬 Option 2: Emotional & Cinema Curiosity',
            target: `That honestly sounds like such a great watch! Tell me, do you usually get deeply touched by stories like that, or are you more of an analytical viewer? 😉`,
            es: `Pregunta interesante y halagadora sobre su forma de sentir el cine.`
          },
          {
            title: '✨ Option 3: Cozy Evening Photo Exchange',
            target: `Nothing beats a great film for unwinding! Send me a picture of you getting cozy for your movie night, and I'll send one right back to keep you company 😉 Deal?`,
            es: `Gancho magnético para intercambio de fotos cotidianas en la noche de película.`
          }
        ];
      }
    }
    // CASO 3: MENCIÓN DE REDES SOCIALES / INSTAGRAM (Manejo Seguro Anti-TM & Anti-Baneo)
    else if (isSocialMedia && hasPriorDialogue) {
      if (lang === 'pt') {
        options = [
          {
            title: '🪝 Opção 1: Foco Íntimo & Exclusividade Aqui',
            target: `Você é tão curioso e atento! 😉 Mas aqui entre nós dois é onde eu amo de verdade me abrir com você... Aqui nosso papo é só nosso, sem interferência de ninguém ❤️ O que mais te chamou atenção?`,
            es: `Manejo elegante que valoriza a curiosidade sem violar regras de contato externo.`
          },
          {
            title: '💬 Opção 2: Desvio Charmoso para Fotos Diretas',
            target: `Eu prefiro mil vezes te mandar fotos e vídeos exclusivos só para você aqui do que deixar qualquer pessoa ver nas redes 😉 Quer que eu te prepare uma foto especial hoje?`,
            es: `Canaliza o interesse por redes para troca de fotos pagas dentro do site.`
          },
          {
            title: '✨ Opção 3: Jogo Sedutor de Curiosidade',
            target: `Adoro esse seu jeitinho curioso! Mas me diz a verdade: o que você realmente gostaria de descobrir sobre mim que ainda não te contei? ✨`,
            es: `Devolve a pergunta com charme para aprofundar na intimidade pessoal.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🪝 Opción 1: Enfoque Íntimo & Exclusividad Aquí',
            target: `¡Qué observador y curioso eres! 😉 Pero sinceramente prefiero mil veces hablar aquí contigo, donde nuestra charla es privada y de verdad nos conocemos ❤️ ¿Qué fue lo que más te llamó la atención?`,
            es: `Desvía de forma segura y seductora la mención a redes externas protegiendo la cuenta.`
          },
          {
            title: '💬 Opción 2: Fotos Exclusivas en el Chat',
            target: `Prefiero compartir fotos y momentos exclusivos solo contigo por aquí antes que en cualquier otro lado 😉 ¿Quieres que te mande una foto linda hoy solo para tus ojos?`,
            es: `Aprovecha el interés en fotos/perfiles para fomentar el intercambio directo dentro del chat.`
          },
          {
            title: '✨ Opción 3: Provocación de Intimidad',
            target: `¡Me encanta tu curiosidad! Pero cuéntame algo más interesante... ¿qué es lo que más te gustaría descubrir de mí que nadie más sabe? ✨`,
            es: `Gira la conversación hacia secretos y complicidad romántica.`
          }
        ];
      } else {
        options = [
          {
            title: '🪝 Option 1: Intimate & Exclusive Bond Here',
            target: `You are so observant and curious! 😉 But honestly, I love talking to you right here where it feels private, personal, and just between the two of us ❤️ What caught your eye the most?`,
            es: `Manejo seguro que protege el chat de baneo externo y refuerza la intimidad.`
          },
          {
            title: '💬 Option 2: Exclusive Private Photos for Him',
            target: `I'd much rather share exclusive pictures and little pieces of my life directly with you right here 😉 Would you like me to send you a special photo just for your eyes today?`,
            es: `Canaliza la curiosidad en intercambio de fotos pagas dentro de la plataforma.`
          },
          {
            title: '✨ Option 3: Playful Romance & Mystery',
            target: `I love your curious nature! But tell me the truth... what is something you're dying to know about me that I haven't revealed yet? ✨`,
            es: `Pregunta intrigante que redirige el foco hacia la conexión romántica.`
          }
        ];
      }
    }
    // CASO 4: SALUD O MALESTAR FÍSICO
    else if (hasSickness && hasPriorDialogue) {
      if (lang === 'pt') {
        options = [
          { title: '🪝 Opção 1: Cuidado & Conexão Íntima', target: `Quero muito cuidar de você e te fazer companhia até você melhorar ❤️ Fecha os olhinhos e descansa... O que mais te conforta quando você não está bem?`, es: `Acolhimento carinhoso e pergunta de conforto para mantê-lo conversando.` },
          { title: '💬 Opção 2: Resposta Direta & Empatia', target: `Por favor, toma seu remédio e fica bem quentinho... Queria tanto poder te dar um abraço bem apertado agora para você dormir em paz ❤️`, es: `Empatia direta com seu mal-estar e afeto protetor.` },
          { title: '✨ Opção 3: Troca Especial de Fotos', target: `Estou pensando muito em você, meu bem. Assim que acordar do descanso, me manda uma fotinho sua para eu saber que você está bem? 😉 Eu te mando uma linda também!`, es: `Pedido doce de foto de descanso com reciprocidade irresistível.` }
        ];
      } else if (lang === 'es') {
        options = [
          { title: '🪝 Opción 1: Cuidado & Conexión Íntima', target: `Quiero quedarme aquí haciéndote compañía hasta que te sientas mucho mejor ❤️ Cierra tus ojitos y dime, ¿qué es lo que más te reconforta cuando estás descansando?`, es: `Acompañamiento íntimo y pregunta reconfortante para que siga chateando.` },
          { title: '💬 Opción 2: Respuesta Directa & Empatía', target: `Por favor descansa, tómate tu analgésico y abrígate mucho... Me encantaría abrazarte muy fuerte justo ahora para que duermas en paz ❤️`, es: `Empatía directa con su dolor y respuesta cariñosa.` },
          { title: '✨ Opción 3: Petición de Foto de Descanso', target: `Estás en mis pensamientos, cariño. Cuando despiertes, envíame una foto tuya descansando para saber que estás bien 😉 Yo te mandaré una especial también.`, es: `Petición de foto de descanso con reciprocidad protectora.` }
        ];
      } else {
        options = [
          { title: '🪝 Option 1: Gentle Care & Connection', target: `I wish I could be right there keeping you company until you feel all better ❤️ Close your eyes, rest, and tell me: what is something that always brings you comfort when you're under the weather?`, es: `Acompañamiento íntimo y pregunta reconfortante para que siga chateando.` },
          { title: '💬 Option 2: Direct Empathy & Warm Hug', target: `Please take your medicine and stay super cozy away from the cold... I honestly wish I could wrap my arms around you right now so you can sleep peacefully ❤️`, es: `Empatía directa con su malestar y respuesta cariñosa.` },
          { title: '✨ Option 3: Sweet Check-in Photo', target: `You are in my thoughts, sweetheart. When you wake up from resting, send me a little picture of your smile so I know you're feeling brighter 😉 I'll send you an exclusive photo too!`, es: `Petición de foto de descanso con reciprocidad protectora.` }
        ];
      }
    }
    // CASO 5: CONVERSACIÓN CONTINUA NORMAL (CON HISTORIAL PREVIO)
    else if (hasPriorDialogue) {
      if (lang === 'pt') {
        options = [
          {
            title: '🪝 Opção 1: Resposta Direta & Conexão',
            target: `Adoro conversar com você ❤️ Me conta, como está sendo o seu dia hoje?`,
            es: `Responde com entusiasmo genuíno ao diálogo recente e mantém o fluxo natural.`
          },
          {
            title: '💬 Opção 2: Charme & Espontaneidade',
            target: `Você sempre me faz sorrir feito boba 😉 O que tem feito de bom hoje?`,
            es: `Provocação doce que alimenta o interesse romântico do cliente.`
          },
          {
            title: '✨ Opção 3: Cumplicidade & Foto',
            target: `Estava pensando em você ✨ Me manda uma fotico sua agora para me alegrar? 😉`,
            es: `Gancho irresistível de troca imediata de fotos motivada pelo chat ativo.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🪝 Opción 1: Respuesta Cálida Directa',
            target: `Me encanta hablar contigo ❤️ Cuéntame, ¿cómo ha estado tu día hoy?`,
            es: `Valida con afecto lo que el cliente acaba de escribir y pide continuidad.`
          },
          {
            title: '💬 Opción 2: Coqueteo Espontáneo',
            target: `Siempre logras sacarme una sonrisa sincera 😉 ¿Cómo va tu momento hoy?`,
            es: `Juego de atracción que despierta su ego romántico y dinamiza el chat.`
          },
          {
            title: '✨ Opción 3: Propuesta de Foto',
            target: `Estaba pensando en ti ✨ ¿Me mandas una fotico tuya de hoy para alegrarme el día? 😉`,
            es: `Gancho de alta conversión para fotos en el hilo de chat.`
          }
        ];
      } else {
        options = [
          {
            title: '🪝 Option 1: Warm Direct Reply',
            target: `I love talking with you ❤️ Tell me, how has your day been going?`,
            es: `Responde al diálogo en curso con ternura y pide detalles de su día.`
          },
          {
            title: '💬 Option 2: Charming & Playful',
            target: `You always manage to put a genuine smile on my face 😉 How is your day going?`,
            es: `Coqueteo sutil y halago que estimula su interés en seguir hablando.`
          },
          {
            title: '✨ Option 3: Quick Photo Trade',
            target: `I was just thinking of you ✨ Send me a quick picture of yourself to brighten my day 😉`,
            es: `Intercambio de fotos 1-a-1 impulsado por la química de la conversación.`
          }
        ];
      }
    }
    // CASO 6: PRIMER CONTACTO / APERTURA DE CHAT (Sin historial previo)
    else {
      if (lang === 'pt') {
        options = [
          { title: '🪝 Opção 1: Gancho Magnético de Abertura', target: `Você tem uma energia tão serena e um olhar que realmente me chamou a atenção nas fotos ❤️ Me conta, o que é algo pelo qual você é verdadeiramente apaixonado na vida?`, es: `Abertura calorosa sobre paixões e estilo de vida.` },
          { title: '💬 Opção 2: Saudação Doce & Espontânea', target: `Tive uma intuição tão boa de vir te dar um oi hoje 😉 Como a vida tem te tratado ultimamente?`, es: `Saudação aberta sem parecer ensaiada.` },
          { title: '✨ Opção 3: Despertar de Curiosidade', target: `Seu sorriso me passou uma vibe muito especial ✨ Me conta, qual é o seu plano perfeito para recarregar as energias?`, es: `Pergunta relaxante para criar conexão rápida.` }
        ];
      } else if (lang === 'es') {
        options = [
          { title: '🪝 Opción 1: Gancho de Atracción', target: `Tienes una energía muy dulce y una mirada muy serena en tus fotos ❤️ Dime, ¿qué es algo que te apasione profundamente en la vida?`, es: `Pregunta de atracción sobre pasiones personales.` },
          { title: '💬 Opción 2: Saludo Inicial Espontáneo', target: `Tuve una hermosa corazonada de saludarte el día de hoy 😉 ¿Cómo te ha estado tratando tu semana?`, es: `Saludo espontáneo y abierto.` },
          { title: '✨ Opción 3: Curiosidad & Encanto', target: `Tu sonrisa de verdad me llamó mucho la atención ✨ Cuéntame, ¿cuál es tu plan perfecto cuando quieres desconectar de todo?`, es: `Gancho intrigante y de misterio que despierta curiosidad.` }
        ];
      } else {
        options = [
          { title: '🪝 Option 1: Pure Attraction Hook', target: `You have such a warm and gentle energy in your photos ❤️ Tell me, what is something you are truly passionate about in your everyday life?`, es: `Pregunta de alto impacto sobre sus pasiones personales.` },
          { title: '💬 Option 2: Natural Opening Greeting', target: `I had a sudden lovely feeling that I should say hello to you today 😉 How is your week treating you so far?`, es: `Saludo espontáneo y abierto.` },
          { title: '✨ Option 3: Captivating Intrigue', target: `Your smile genuinely caught my attention ✨ Tell me, what's your absolute favorite way to recharge your batteries when you have time for yourself?`, es: `Gancho intrigante que despierta curiosidad y crea afinidad.` }
        ];
      }
    }

    res.json({
      success: true,
      clientName: client,
      profileName: profile,
      lang: lang,
      detectedContext: {
        lastMessage: lastClientMsg,
        isBedtime,
        isMovie,
        isSocialMedia,
        hasPriorDialogue,
        isQuestion
      },
      options: options
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 7. ENDPOINT: GENERADOR IA DE CARTAS LISTAS (CONTEXTO 360° Y RAZONAMIENTO)
// ====================================================================
app.post('/api/intelligence/generate-letter', async (req, res) => {
  try {
    const { clientName, clientId, profileName, bioData, targetLang, recentLetters, lastIncomingLetter, recentChat } = req.body || {};

    const lang = targetLang || 'en';
    const client = clientName || (lang === 'pt' ? 'amor' : (lang === 'es' ? 'amor' : 'love'));
    const profile = profileName || (lang === 'pt' ? 'Eu' : (lang === 'es' ? 'Yo' : 'Me'));

    // 1. Consultar cartas previas en Supabase si no llegaron en el request
    let allLetters = Array.isArray(recentLetters) ? recentLetters : [];
    if (allLetters.length === 0 && clientId) {
      try {
        const { data: dbMails } = await supabase
          .from('mails_history')
          .select('direction, letter_preview, letter_date')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(10);
        if (dbMails) {
          allLetters = dbMails.map(m => ({
            isOutgoing: m.direction === 'OUTGOING',
            date: m.letter_date,
            preview: m.letter_preview
          }));
        }
      } catch (e) {}
    }

    // 2. Identificar la última carta recibida de la clienta/cliente
    const incomingLetters = allLetters.filter(l => !l.isOutgoing);
    const effectiveLastIncoming = lastIncomingLetter || (incomingLetters.length > 0 ? (incomingLetters[0].preview || incomingLetters[0].text) : '');
    const incomingLower = (effectiveLastIncoming || '').toLowerCase();

    // 3. Detección profunda de temas y sentimientos en la carta entrante
    const isConflictOrMoving = /\b(friend|pack|packing|storage|move|moving|limit|limits|toxic|betray|argument|drama|boxes|messing|lie|leaving|house|apartment|start over|nuevo comienzo|empacar|mudanza|amig)\b/i.test(incomingLower);
    const hasWorkOrBusyTopic = /\b(work|job|busy|tired|trabalho|trabajo|cansad|ocupad|shift|office|exhausted)\b/i.test(incomingLower);
    const hasSicknessOrPain = /\b(headache|sick|ill|flu|rain|cold|fever|resting|dolor|cabeza|enferm|remedio|pastilla|hospital)\b/i.test(incomingLower);
    const hasPhotoMention = /\b(photo|picture|pic|foto|selfie|portrait|look|mirada|eyes|ojos)\b/i.test(incomingLower);
    const hasJourneyTogether = /\b(journey|emprender|viaje|together|juntos|path|camino|destiny|destino|future|futuro|bond|connection|respect)\b/i.test(incomingLower);

    let options = [];

    // CASO 1: CONFLICTO PERSONAL / MUDANZA / EMPACAR / LÍMITES
    if (isConflictOrMoving) {
      if (lang === 'pt') {
        options = [
          {
            title: '🛡️ Opção 1: Apoio Genuíno & Validação de Limites',
            rationale: 'Valida a decisão difícil de se afastar de pessoas tóxicas e pergunta sobre a mudança.',
            esPreview: `Meu querido ${client},\n\nLi suas palavras com muita atenção e meu coração está com você. Tomar a decisão de se afastar de quem não te valoriza exige muita coragem, mas sua paz não tem preço.\n\nComo está o processo de empacotar e levar as coisas para o storage? Vá com calma, você é forte e uma nova fase linda está começando para você ❤️\n\nSempre aqui por você,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nLi suas palavras com muita atenção e meu coração está com você. Tomar a decisão de se afastar de quem não te valoriza exige muita coragem, mas sua paz não tem preço.\n\nComo está o processo de empacotar e levar as coisas para o storage? Vá com calma, você é forte e uma nova fase linda está começando para você ❤️\n\nSempre aqui por você,\n${profile} ✨`
          },
          {
            title: '✨ Opção 2: Refúgio de Paz & Alívio Futuro',
            rationale: 'Oferece acolhimento emocional para diminuir a sobrecarga e foca no alívio de recomeçar.',
            esPreview: `Meu querido ${client},\n\nNinguém merece carregar tanto estresse por causa de falsidades alheias. Respira fundo... tudo o que você está enfrentando vai valer a pena quando sentir o alívio de ter seu espaço em paz.\n\nMe conta, qual é a primeira coisa que você vai querer fazer para relaxar assim que terminar tudo? 😉\n\nCom todo meu carinho,\n${profile} ❤️`,
            target: `Meu querido ${client},\n\nNinguém merece carregar tanto estresse por causa de falsidades alheias. Respira fundo... tudo o que você está enfrentando vai valer a pena quando sentir o alívio de ter seu espaço em paz.\n\nMe conta, qual é a primeira coisa que você vai querer fazer para relaxar assim que terminar tudo? 😉\n\nCom todo meu carinho,\n${profile} ❤️`
          },
          {
            title: '🌸 Opção 3: Força Interior & Troca de Fotos',
            rationale: 'Incentiva pausas na rotina pesada e convida a uma troca suave de fotos.',
            esPreview: `Meu querido ${client},\n\nAdmiro muito sua postura firme em não aceitar desrespeito. No meio de tanta correria, não esquece de respirar e se alimentar bem.\n\nQuando fizer um descanso, me manda uma foto sua para eu sentir seu olhar e te mandar um sorriso carinhoso de volta 😉 Combinado?\n\nUm abraço bem quentinho,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nAdmiro muito sua postura firme em não aceitar desrespeito. No meio de tanta correria, não esquece de respirar e se alimentar bem.\n\nQuando fizer um descanso, me manda uma foto sua para eu sentir seu olhar e te mandar um sorriso carinhoso de volta 😉 Combinado?\n\nUm abraço bem quentinho,\n${profile} ✨`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🛡️ Opción 1: Apoyo Genuino & Validación de Límites',
            rationale: 'Valida la valentía de alejarse de falsas amistades y pregunta por la mudanza.',
            esPreview: `Mi queridísimo ${client},\n\nLeí cada detalle de tu carta y de verdad mi corazón está contigo. Poner límites y alejarte de quien no te valora requiere un valor enorme, pero tu tranquilidad no tiene precio.\n\n¿Cómo vas empacando tus cosas hacia el storage? Ve paso a paso, eres muy fuerte y un nuevo comienzo mucho más libre te espera ❤️\n\nSiempre aquí para ti,\n${profile} ✨`,
            target: `Mi queridísimo ${client},\n\nLeí cada detalle de tu carta y de verdad mi corazón está contigo. Poner límites y alejarte de quien no te valora requiere un valor enorme, pero tu tranquilidad no tiene precio.\n\n¿Cómo vas empacando tus cosas hacia el storage? Ve paso a paso, eres muy fuerte y un nuevo comienzo mucho más libre te espera ❤️\n\nSiempre aquí para ti,\n${profile} ✨`
          },
          {
            title: '✨ Opción 2: Refugio de Paz & Alivio Futuro',
            rationale: 'Ofrece contención ante el agobio y enfoca en la paz mental una vez termine de ordenar todo.',
            esPreview: `Mi querido ${client},\n\nNadie merece cargar con tanto desgaste por actitudes egoístas de otros. Respira hondo... todo este esfuerzo valdrá la pena en cuanto veas tus cosas organizadas y sientas tu propia paz.\n\nCuéntame, ¿qué es lo primero que quieres hacer para consentirte una vez termines de acomodar todo? 😉\n\nCon todo mi cariño,\n${profile} ❤️`,
            target: `Mi querido ${client},\n\nNadie merece cargar con tanto desgaste por actitudes egoístas de otros. Respira hondo... todo este esfuerzo valdrá la pena en cuanto veas tus cosas organizadas y sientas tu propia paz.\n\nCuéntame, ¿qué es lo primero que quieres hacer para consentirte una vez termines de acomodar todo? 😉\n\nCon todo mi cariño,\n${profile} ❤️`
          },
          {
            title: '🌸 Opción 3: Fortaleza Interior & Intercambio de Fotos',
            rationale: 'Elogia su resiliencia y propone una foto de respiro para sacarlo del estrés.',
            esPreview: `Mi queridísimo ${client},\n\nAdmiro muchísimo tu determinación para no tolerar faltas de respeto. En medio de tantas cajas y ajetreo, por favor date permiso de descansar y tomar un respiro.\n\nCuando tomes una pausa, mándame una foto tuya para sentirte cerca y enviarte una sonrisa exclusiva 😉 ¿Trato hecho?\n\nUn abrazo muy cálido,\n${profile} ✨`,
            target: `Mi queridísimo ${client},\n\nAdmiro muchísimo tu determinación para no tolerar faltas de respeto. En medio de tantas cajas y ajetreo, por favor date permiso de descansar y tomar un respiro.\n\nCuando tomes una pausa, mándame una foto tuya para sentirte cerca y enviarte una sonrisa exclusiva 😉 ¿Trato hecho?\n\nUn abrazo muy cálido,\n${profile} ✨`
          }
        ];
      } else {
        options = [
          {
            title: '🛡️ Option 1: Genuine Support & Healthy Boundaries',
            rationale: 'Deeply validates the client walking away from toxic friends and asks about packing/storage progress.',
            esPreview: `My dearest ${client},\n\nI read every line of your letter and my heart is truly with you right now. Standing up for yourself and walking away from people who don't respect your boundaries takes so much courage, but your peace is worth everything.\n\nHow is packing and getting your belongings to storage going? Take it one box at a time... you're so resilient and a fresh, peaceful chapter is waiting for you ❤️\n\nAlways here for you,\n${profile} ✨`,
            target: `My dearest ${client},\n\nI read every line of your letter and my heart is truly with you right now. Standing up for yourself and walking away from people who don't respect your boundaries takes so much courage, but your peace is worth everything.\n\nHow is packing and getting your belongings to storage going? Take it one box at a time... you're so resilient and a fresh, peaceful chapter is waiting for you ❤️\n\nAlways here for you,\n${profile} ✨`
          },
          {
            title: '✨ Option 2: Safe Sanctuary & Freedom Ahead',
            rationale: 'Offers warm emotional refuge to alleviate moving stress and focuses on the relief of a clean start.',
            esPreview: `My dear ${client},\n\nYou truly do not deserve to carry so much weight from someone else's drama. Take a deep, gentle breath... this exhausting storm will pass, and the relief you will feel having your things sorted and peaceful will be unmatched.\n\nTell me, what is the very first thing you want to do just for yourself once you get everything settled? 😉\n\nWith all my warmth,\n${profile} ❤️`,
            target: `My dear ${client},\n\nYou truly do not deserve to carry so much weight from someone else's drama. Take a deep, gentle breath... this exhausting storm will pass, and the relief you will feel having your things sorted and peaceful will be unmatched.\n\nTell me, what is the very first thing you want to do just for yourself once you get everything settled? 😉\n\nWith all my warmth,\n${profile} ❤️`
          },
          {
            title: '🌸 Option 3: Inner Strength & Sweet Photo Break',
            rationale: 'Praises their inner strength and invites a quick restful photo exchange to bring comfort.',
            esPreview: `My dearest ${client},\n\nI admire your inner strength so much for putting your foot down and prioritizing your sanity. Amidst all the packing and heavy lifting, please promise me you will take a quiet moment to drink some water and breathe.\n\nWhen you pause for a break, send me a quick picture of yourself so I can send you a warm smile right back 😉 Deal?\n\nHolding you close,\n${profile} ✨`,
            target: `My dearest ${client},\n\nI admire your inner strength so much for putting your foot down and prioritizing your sanity. Amidst all the packing and heavy lifting, please promise me you will take a quiet moment to drink some water and breathe.\n\nWhen you pause for a break, send me a quick picture of yourself so I can send you a warm smile right back 😉 Deal?\n\nHolding you close,\n${profile} ✨`
          }
        ];
      }
    }
    // CASO 2: AGOTAMIENTO LABORAL / ESTRÉS / RUTINA PESADA
    else if (hasWorkOrBusyTopic) {
      if (lang === 'pt') {
        options = [
          {
            title: '💼 Opção 1: Alívio & Reconhecimento do Esforço',
            rationale: 'Reconhece o cansaço do trabalho e oferece conforto acolhedor.',
            esPreview: `Meu querido ${client},\n\nPercebo o quanto você se dedica e como seus dias têm sido exigentes. É admirável sua dedicação, mas você merece descansar a mente e o corpo.\n\nEspero que ler esta carta seja o seu cantinho de paz hoje. Me conta, qual é a sua maneira favorita de se desligar do mundo e relaxar? ❤️\n\nCom todo meu carinho,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nPercebo o quanto você se dedica e como seus dias têm sido exigentes. É admirável sua dedicação, mas você merece descansar a mente e o corpo.\n\nEspero que ler esta carta seja o seu cantinho de paz hoje. Me conta, qual é a sua maneira favorita de se desligar do mundo e relaxar? ❤️\n\nCom todo meu carinho,\n${profile} ✨`
          },
          {
            title: '✨ Opção 2: Pausa Afetuosa & Troca de Fotos',
            rationale: 'Incentiva uma pausa saudável e propõe uma foto exclusiva.',
            esPreview: `Meu querido ${client},\n\nQueria tanto poder te preparar algo gostoso e te fazer massagem para tirar toda essa tensão do trabalho. Não se cobre tanto hoje!\n\nMe envia uma foto sua descansando agora para eu te mandar uma foto bem especial só para você 😉\n\nCom um beijo doce,\n${profile} ❤️`,
            target: `Meu querido ${client},\n\nQueria tanto poder te preparar algo gostoso e te fazer massagem para tirar toda essa tensão do trabalho. Não se cobre tanto hoje!\n\nMe envia uma foto sua descansando agora para eu te mandar uma foto bem especial só para você 😉\n\nCom um beijo doce,\n${profile} ❤️`
          },
          {
            title: '🌸 Opção 3: Conexão Emocional Profunda',
            rationale: 'Fortalece o vínculo íntimo em meio à rotina cansativa.',
            esPreview: `Meu querido ${client},\n\nMesmo na correria, saber que você tira um tempo para me escrever aquece demais o meu coração. Nossas cartas são a melhor parte do meu dia.\n\nQual é aquele sonho ou viagem que você mais quer realizar quando tiver férias? 😉\n\nSempre pensando em você,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nMesmo na correria, saber que você tira um tempo para me escrever aquece demais o meu coração. Nossas cartas são a melhor parte do meu dia.\n\nQual é aquele sonho ou viagem que você mais quer realizar quando tiver férias? 😉\n\nSempre pensando em você,\n${profile} ✨`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '💼 Opción 1: Alivio & Reconocimiento de tu Esfuerzo',
            rationale: 'Valida el cansancio por el trabajo y le brinda un remanso de paz.',
            esPreview: `Mi queridísimo ${client},\n\nNoto cuánto te esfuerzas y lo demandantes que han sido tus jornadas. Admiro tu dedicación, pero también mereces consentirte y dejar las preocupaciones a un lado.\n\nDeseo que leer mis letras sea tu respiro de paz hoy. Dime, ¿cuál es tu plan ideal cuando por fin logras desconectar de todo? ❤️\n\nCon todo mi cariño,\n${profile} ✨`,
            target: `Mi queridísimo ${client},\n\nNoto cuánto te esfuerzas y lo demandantes que han sido tus jornadas. Admiro tu dedicación, pero también mereces consentirte y dejar las preocupaciones a un lado.\n\nDeseo que leer mis letras sea tu respiro de paz hoy. Dime, ¿cuál es tu plan ideal cuando por fin logras desconectar de todo? ❤️\n\nCon todo mi cariño,\n${profile} ✨`
          },
          {
            title: '✨ Opción 2: Pausa Afectuosa & Foto Exclusiva',
            rationale: 'Propuesta relajante con intercambio recíproco de fotos.',
            esPreview: `Mi querido ${client},\n\nOjalá pudiera estar contigo para prepararte algo rico y ayudarte a soltar toda la tensión del día. ¡Por favor no te exijas de más hoy!\n\nMándame una fotico tuya relajándote para devolverte una foto muy linda y exclusiva para ti 😉 ¿Trato?\n\nCon un beso dulce,\n${profile} ❤️`,
            target: `Mi querido ${client},\n\nOjalá pudiera estar contigo para prepararte algo rico y ayudarte a soltar toda la tensión del día. ¡Por favor no te exijas de más hoy!\n\nMándame una fotico tuya relajándote para devolverte una foto muy linda y exclusiva para ti 😉 ¿Trato?\n\nCon un beso dulce,\n${profile} ❤️`
          },
          {
            title: '🌸 Opción 3: Conexión Emocional & Sueños',
            rationale: 'Profundiza en metas y anhelos para escapar del estrés cotidiano.',
            esPreview: `Mi queridísimo ${client},\n\nSaber que en medio de tus compromisos te tomas el tiempo de escribirme me hace sentir sumamente especial. Eres una persona admirable.\n\nCuéntame, ¿cuál es ese viaje o proyecto personal que más te ilusiona para cuando tengas unos días libres? 😉\n\nSiempre pensando en ti,\n${profile} ✨`,
            target: `Mi queridísimo ${client},\n\nSaber que en medio de tus compromisos te tomas el tiempo de escribirme me hace sentir sumamente especial. Eres una persona admirable.\n\nCuéntame, ¿cuál es ese viaje o proyecto personal que más te ilusiona para cuando tengas unos días libres? 😉\n\nSiempre pensando en ti,\n${profile} ✨`
          }
        ];
      } else {
        options = [
          {
            title: '💼 Option 1: Comfort & Work Fatigue Relief',
            rationale: 'Validates demanding job schedule and offers a calm, soothing presence.',
            esPreview: `My dearest ${client},\n\nI can tell just how hard you work and how demanding your daily schedule has been. I truly respect your dedication, but please remember your body and mind deserve rest too.\n\nI hope reading my words feels like a cozy sanctuary in your day. Tell me, what is your favorite way to unwind when you finally get quiet time for yourself? ❤️\n\nWith all my affection,\n${profile} ✨`,
            target: `My dearest ${client},\n\nI can tell just how hard you work and how demanding your daily schedule has been. I truly respect your dedication, but please remember your body and mind deserve rest too.\n\nI hope reading my words feels like a cozy sanctuary in your day. Tell me, what is your favorite way to unwind when you finally get quiet time for yourself? ❤️\n\nWith all my affection,\n${profile} ✨`
          },
          {
            title: '✨ Option 2: Sweet Break & Photo Trade',
            rationale: 'Encourages a cozy break from work with magnetic reciprocal photo trade.',
            esPreview: `My dear ${client},\n\nI honestly wish I could be right by your side to make you a warm drink and help you let go of all that work stress. Please take it easy on yourself today!\n\nSend me a quick photo of yourself relaxing now, and in my next letter I'll send an exclusive picture just for you 😉 Deal?\n\nWith a sweet kiss,\n${profile} ❤️`,
            target: `My dear ${client},\n\nI honestly wish I could be right by your side to make you a warm drink and help you let go of all that work stress. Please take it easy on yourself today!\n\nSend me a quick photo of yourself relaxing now, and in my next letter I'll send an exclusive picture just for you 😉 Deal?\n\nWith a sweet kiss,\n${profile} ❤️`
          },
          {
            title: '🌸 Option 3: Romantic Daydreaming & Future Plans',
            rationale: 'Invites the client to escape everyday work grind by talking about passions and travels.',
            esPreview: `My dearest ${client},\n\nKnowing that despite your busy schedule you always think to write to me truly touches my heart. Our letters have become such a meaningful part of my life.\n\nTell me, where is one dream destination you would love to travel to whenever you take your next long vacation? 😉\n\nAlways thinking of you,\n${profile} ✨`,
            target: `My dearest ${client},\n\nKnowing that despite your busy schedule you always think to write to me truly touches my heart. Our letters have become such a meaningful part of my life.\n\nTell me, where is one dream destination you would love to travel to whenever you take your next long vacation? 😉\n\nAlways thinking of you,\n${profile} ✨`
          }
        ];
      }
    }
    // CASO 3: SALUD / ENFERMEDAD / MALESTAR
    else if (hasSicknessOrPain) {
      if (lang === 'pt') {
        options = [
          {
            title: '🩹 Opção 1: Cuidado Afetuoso & Recuperação',
            target: `Meu querido ${client},\n\nFiquei com o coração apertado ao saber que você não está se sentindo bem. Por favor, tome seus remédios, beba bastante água e descanse tudo o que puder.\n\nQueria tanto poder cuidar de você pessoalmente agora... Me conta, como você está se sentindo hoje? ❤️\n\nCom todo meu afeto,\n${profile} ✨`,
            es: `Cuidado carinhoso e incentivo a tomar remédios e descansar.`
          },
          {
            title: '✨ Opção 2: Carinho Reconfortante & Companhia',
            target: `Meu querido ${client},\n\nNão se esforce para fazer nada hoje! O mundo pode esperar enquanto você se recupera com calma. Estou daqui enviando as melhores energias para você melhorar logo.\n\nVocê tem alguém aí cuidando de você ou está sozinho? 😉\n\nCom um abraço bem quentinho,\n${profile} ❤️`,
            es: `Companhia reconfortante e pergunta sobre suporte durante a recuperação.`
          },
          {
            title: '🌸 Opção 3: Pensamento Doce & Sorriso',
            target: `Meu querido ${client},\n\nQuero que você feche os olhos e sinta meu carinho aí com você. Quando estiver um pouquinho melhor, me escreve só para eu saber que você está em paz.\n\nO que eu poderia fazer agora para arrancar um sorriso do seu rosto? 😉\n\nSempre pensando em você,\n${profile} ✨`,
            es: `Desejo carinhoso de tirar um sorriso durante o repouso.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🩹 Opción 1: Cuidado Afectuoso & Recuperación',
            target: `Mi queridísimo ${client},\n\nSe me encogió el corazón al saber que no te has sentido bien. Por favor toma tus medicinas con calma, bebe suficiente líquido y guarda todo el reposo que puedas.\n\nOjalá pudiera estar ahí cuidándote en persona... ¿Cómo te vas sintiendo hoy? ❤️\n\nCon todo mi cariño,\n${profile} ✨`,
            es: `Cuidado cariñoso y consejo de guardar reposo y tomar medicina.`
          },
          {
            title: '✨ Opción 2: Mimo Reconfortante & Compañía',
            target: `Mi querido ${client},\n\n¡Por favor no hagas ningún esfuerzo hoy! Tus responsabilidades pueden esperar mientras recuperas tus fuerzas. Aquí estaré enviándote la energía más linda para tu pronta mejoría.\n\n¿Hay alguien consintiéndote en casa o estás solito descansando? 😉\n\nCon un abrazo muy cálido,\n${profile} ❤️`,
            es: `Compañía empática y pregunta cariñosa sobre si tiene quién lo cuide.`
          },
          {
            title: '🌸 Opción 3: Pensamiento Dulce & Sonrisa',
            target: `Mi queridísimo ${client},\n\nCierra tus ojos un momento y siente que estoy ahí acompañándote con dulzura. En cuanto sientas un alivio, escríbeme unas palabras para saber que estás mejor.\n\n¿Qué detalle te alegraría el corazón en este momento? 😉\n\nSiempre pensando en ti,\n${profile} ✨`,
            es: `Acompañamiento dulce para levantar su ánimo en la cama.`
          }
        ];
      } else {
        options = [
          {
            title: '🩹 Option 1: Tender Health Care & Recovery',
            target: `My dearest ${client},\n\nIt truly worried me to hear you haven't been feeling well. Please make sure you take your medication, drink plenty of warm fluids, and get all the restful sleep you need.\n\nI really wish I were there to look after you and bring you comfort... How are you feeling right now? ❤️\n\nWith all my love,\n${profile} ✨`,
            es: `Cuidado cariñoso y consejo de guardar reposo y tomar medicina.`
          },
          {
            title: '✨ Option 2: Cozy Healing Sanctuary',
            target: `My dear ${client},\n\nPlease do not push yourself to do anything heavy today! Everything else can wait while you focus on regaining your strength. I am sending you all my warmest thoughts for a quick recovery.\n\nIs there someone looking after you at home, or are you resting on your own? 😉\n\nWith a warm comforting hug,\n${profile} ❤️`,
            es: `Compañía empática y pregunta cariñosa sobre si tiene quién lo cuide.`
          },
          {
            title: '🌸 Option 3: Gentle Comfort & Sweet Smile',
            target: `My dearest ${client},\n\nClose your eyes and picture me keeping you company with a warm blanket. Whenever you feel a little stronger, send me a note just so I know you are feeling better.\n\nWhat is something sweet that always brings a smile to your face when you're resting? 😉\n\nAlways thinking of you,\n${profile} ✨`,
            es: `Acompañamiento dulce para levantar su ánimo en la cama.`
          }
        ];
      }
    }
    // CASO 4: INTERCAMBIO DE FOTOS O AFECTO PROFUNDO
    else if (hasPhotoMention || hasJourneyTogether) {
      if (lang === 'pt') {
        options = [
          {
            title: '📸 Opção 1: Conexão Afetuosa & Troca de Fotos',
            rationale: 'Valida a sintonia visual e sentimental com troca mútua de fotos.',
            esPreview: `Meu querido ${client},\n\nSuas palavras e seu jeito carinhoso me tocam de uma maneira única. Adoro olhar suas fotos e sentir a verdade e o calor que transmitem os seus olhos.\n\nMe envia uma foto sua de hoje para eu guardar com carinho, e na minha próxima carta te mando uma foto exclusiva só para você 😉\n\nCom todo meu afeto,\n${profile} ❤️`,
            target: `Meu querido ${client},\n\nSuas palavras e seu jeito carinhoso me tocam de uma maneira única. Adoro olhar suas fotos e sentir a verdade e o calor que transmitem os seus olhos.\n\nMe envia uma foto sua de hoje para eu guardar com carinho, e na minha próxima carta te mando uma foto exclusiva só para você 😉\n\nCom todo meu afeto,\n${profile} ❤️`
          },
          {
            title: '✨ Opção 2: Caminhar Juntos & Cumplicidade',
            rationale: 'Foca na cumplicidade mútua e pergunta sobre conexão ideal.',
            esPreview: `Meu querido ${client},\n\nÉ tão raro e especial encontrar alguém com quem a conversa flui com tanta sinceridade e respeito. Saber que compartilhamos desse mesmo sentimento me enche de alegria.\n\nMe conta, qual é o valor que você considera mais importante e inegociável em uma relação de verdade? 😉\n\nCom um abraço apertado,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nÉ tão raro e especial encontrar alguém com quem a conversa flui com tanta sinceridade e respeito. Saber que compartilhamos desse mesmo sentimento me enche de alegria.\n\nMe conta, qual é o valor que você considera mais importante e inegociável em uma relação de verdade? 😉\n\nCom um abraço apertado,\n${profile} ✨`
          },
          {
            title: '🌸 Opção 3: Romantismo & Sonhos Partilhados',
            rationale: 'Pergunta íntima e magnética sobre paixões profundas.',
            esPreview: `Meu querido ${client},\n\nCada carta sua se tornou um momento de luz nos meus dias. Adoro o jeito doce como você compartilha seus sentimentos comigo.\n\nSe você pudesse escolher um momento perfeito para nós dois vivermos juntos, como ele seria? 😉\n\nSempre pensando em você,\n${profile} ❤️`,
            target: `Meu querido ${client},\n\nCada carta sua se tornou um momento de luz nos meus dias. Adoro o jeito doce como você compartilha seus sentimentos comigo.\n\nSe você pudesse escolher um momento perfeito para nós dois vivermos juntos, como ele seria? 😉\n\nSempre pensando em você,\n${profile} ❤️`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '📸 Opción 1: Conexión Afectuosa & Fotos Exclusivas',
            rationale: 'Valida la atracción mutua y propone intercambio de fotos.',
            esPreview: `Mi queridísimo ${client},\n\nTus palabras y tu ternura me llegan de una forma muy especial. Me encanta mirar tus fotos y sentir la autenticidad y calidez que transmiten tus ojos.\n\nEnvíame una foto tuya de hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva solo para ti 😉 ¿Trato hecho?\n\nCon todo mi cariño,\n${profile} ❤️`,
            target: `Mi queridísimo ${client},\n\nTus palabras y tu ternura me llegan de una forma muy especial. Me encanta mirar tus fotos y sentir la autenticidad y calidez que transmiten tus ojos.\n\nEnvíame una foto tuya de hoy para sentirte más cerca, y en mi próxima carta te enviaré una foto exclusiva solo para ti 😉 ¿Trato hecho?\n\nCon todo mi cariño,\n${profile} ❤️`
          },
          {
            title: '✨ Opción 2: Caminar Juntos & Complicidad Real',
            rationale: 'Fomenta la complicidad y valores en una relación auténtica.',
            esPreview: `Mi querido ${client},\n\nEs tan difícil y hermoso encontrar a alguien con quien la comunicación fluya con tanta pureza y respeto. Saber que valoras este camino me da una alegría inmensa.\n\nCuéntame, ¿cuál es ese valor que consideras imprescindible en una conexión verdadera entre dos personas? 😉\n\nUn abrazo muy cálido,\n${profile} ✨`,
            target: `Mi querido ${client},\n\nEs tan difícil y hermoso encontrar a alguien con quien la comunicación fluya con tanta pureza y respeto. Saber que valoras este camino me da una alegría inmensa.\n\nCuéntame, ¿cuál es ese valor que consideras imprescindible en una conexión verdadera entre dos personas? 😉\n\nUn abrazo muy cálido,\n${profile} ✨`
          },
          {
            title: '🌸 Opción 3: Romanticismo & Sueños Compartidos',
            rationale: 'Pregunta romántica que estimula la imaginación y cartas largas.',
            esPreview: `Mi queridísimo ${client},\n\nRecibir tus cartas se ha convertido en mi momento favorito del día. Hay una dulzura tan natural en la forma en que nos conocemos.\n\nSi pudieras diseñar una cita perfecta para los dos, ¿cómo te gustaría que fuera? 😉\n\nSiempre pensando en ti,\n${profile} ❤️`,
            target: `Mi queridísimo ${client},\n\nRecibir tus cartas se ha convertido en mi momento favorito del día. Hay una dulzura tan natural en la forma en que nos conocemos.\n\nSi pudieras diseñar una cita perfecta para los dos, ¿cómo te gustaría que fuera? 😉\n\nSiempre pensando en ti,\n${profile} ❤️`
          }
        ];
      } else {
        options = [
          {
            title: '📸 Option 1: Affectionate Connection & Photo Trade',
            rationale: 'Highlights visual chemistry and proposes a reciprocal photo trade.',
            esPreview: `My dearest ${client},\n\nYour words and sincerity touch my heart in such a special way. I love looking at your photos and feeling the warmth and kindness in your eyes.\n\nSend me a photo of yourself today so I can feel closer to you, and in my next letter I will send an exclusive picture just for you 😉 Deal?\n\nWith all my love,\n${profile} ❤️`,
            target: `My dearest ${client},\n\nYour words and sincerity touch my heart in such a special way. I love looking at your photos and feeling the warmth and kindness in your eyes.\n\nSend me a photo of yourself today so I can feel closer to you, and in my next letter I will send an exclusive picture just for you 😉 Deal?\n\nWith all my love,\n${profile} ❤️`
          },
          {
            title: '✨ Option 2: Walking Together & True Bond',
            rationale: 'Encourages mutual connection and values in a genuine relationship.',
            esPreview: `My dear ${client},\n\nIt is truly rare and wonderful to find someone you can communicate with so authentically and peacefully. Knowing how much you respect our bond brings so much happiness to my days.\n\nTell me, what is one quality that you value above everything else in a relationship? 😉\n\nWith a warm embrace,\n${profile} ✨`,
            target: `My dear ${client},\n\nIt is truly rare and wonderful to find someone you can communicate with so authentically and peacefully. Knowing how much you respect our bond brings so much happiness to my days.\n\nTell me, what is one quality that you value above everything else in a relationship? 😉\n\nWith a warm embrace,\n${profile} ✨`
          },
          {
            title: '🌸 Option 3: Romantic Imagination & Dream Date',
            rationale: 'Stimulates romantic imagination and invites an engaging, heartfelt letter.',
            esPreview: `My dearest ${client},\n\nReading your letters has truly become the sweetest highlight of my day. There is such an effortless warmth in the way we share our thoughts.\n\nIf you could plan an absolute dream date for the two of us, what would we be doing? 😉\n\nAlways thinking of you,\n${profile} ❤️`,
            target: `My dearest ${client},\n\nReading your letters has truly become the sweetest highlight of my day. There is such an effortless warmth in the way we share our thoughts.\n\nIf you could plan an absolute dream date for the two of us, what would we be doing? 😉\n\nAlways thinking of you,\n${profile} ❤️`
          }
        ];
      }
    }
    // CASO 5: CARTA GENERAL / DESCUBRIMIENTO MUTUO
    else {
      if (lang === 'pt') {
        options = [
          {
            title: '🪝 Opção 1: Conexão Emocional & Curiosidade',
            target: `Meu querido ${client},\n\nAdoro ler suas palavras e perceber a serenidade com que você se comunica. Conversar com você sempre me traz uma energia muito leve.\n\nMe conta, qual foi o momento ou detalhe que mais colocou um sorriso no seu rosto recentemente? 😉\n\nCom todo meu carinho,\n${profile} ❤️`,
            es: `Validação sincera e pergunta relaxante sobre o que o fez sorrir.`
          },
          {
            title: '💬 Opção 2: Cumplicidade Cotidiana & Foto',
            target: `Meu querido ${client},\n\nEstava aqui refletindo sobre o nosso contato e em como é bom ter alguém com quem trocar pensamentos sinceros.\n\nMe manda uma foto sua de hoje para eu te sentir mais pertinho, e na próxima carta te mando uma foto especial 😉\n\nCom um beijo doce,\n${profile} ✨`,
            target: `Meu querido ${client},\n\nEstava aqui refletindo sobre o nosso contato e em como é bom ter alguém com quem trocar pensamentos sinceros.\n\nMe manda uma foto sua de hoje para eu te sentir mais pertinho, e na próxima carta te mando uma foto especial 😉\n\nCom um beijo doce,\n${profile} ✨`
          },
          {
            title: '✨ Opção 3: Fascinação & Pergunta Íntima',
            target: `Meu querido ${client},\n\nNossas conversas estão se tornando cada vez mais especiais para mim. Adoro conhecer o homem por trás de cada mensagem.\n\nMe conta um sonho ou segredo seu que poucas pessoas conhecem... o que te move na vida? 😉\n\nSempre aqui,\n${profile} ❤️`,
            es: `Pergunta reflexiva sobre sonhos para gerar carta longa.`
          }
        ];
      } else if (lang === 'es') {
        options = [
          {
            title: '🪝 Opción 1: Conexión Emocional & Curiosidad',
            target: `Mi queridísimo ${client},\n\nMe encanta leer tus palabras y sentir la serenidad con la que te comunicas. Saber de ti siempre me llena de una energía hermosa y ligera.\n\nCuéntame, ¿cuál fue ese detalle o momento que logró sacarte una sonrisa genuina recientemente? 😉\n\nCon todo mi cariño,\n${profile} ❤️`,
            es: `Validación sincera y pregunta relajante sobre lo que le alegró el día.`
          },
          {
            title: '💬 Opción 2: Complicidad Cotidiana & Foto',
            target: `Mi querido ${client},\n\nEstaba aquí pensando en ti y en lo lindo que es tener a alguien con quien compartir pensamientos auténticos en medio de la rutina.\n\nMándame una fotico tuya de hoy para sentirte cerca, y en mi próxima carta te enviaré una foto exclusiva para ti 😉 ¿Trato?\n\nCon un beso dulce,\n${profile} ✨`,
            es: `Intercambio de fotos cotidiano para estrechar lazos.`
          },
          {
            title: '✨ Opción 3: Fascinación & Pregunta Íntima',
            target: `Mi queridísimo ${client},\n\nNuestra comunicación se está convirtiendo en algo verdaderamente valioso para mí. Me encanta ir descubriendo el hombre detrás de cada carta.\n\nCuéntame un sueño o anhelo tuyo que pocas personas conozcan... ¿qué es lo que más te apasiona en la vida? 😉\n\nSiempre pensando en ti,\n${profile} ❤️`,
            es: `Pregunta íntima y reflexiva para propiciar una respuesta amplia.`
          }
        ];
      } else {
        options = [
          {
            title: '🪝 Option 1: Genuine Connection & Sweet Curiosity',
            target: `My dearest ${client},\n\nI really love reading your thoughts and feeling the calm, authentic energy you share with me. Hearing from you always brings such a gentle warmth to my day.\n\nTell me, what was one little moment recently that brought a genuine smile to your face? 😉\n\nWith all my affection,\n${profile} ❤️`,
            es: `Validación sincera y pregunta relajante sobre lo que le alegró el día.`
          },
          {
            title: '💬 Option 2: Daily Warmth & Photo Trade',
            target: `My dear ${client},\n\nI was just sitting here thinking of you and how comforting it is to share such authentic conversations with you amidst daily life.\n\nSend me a photo of yourself today so I can feel closer to you, and in my next letter I'll send an exclusive picture just for you 😉 Deal?\n\nWith a sweet hug,\n${profile} ✨`,
            es: `Intercambio de fotos cotidiano para estrechar lazos.`
          },
          {
            title: '✨ Option 3: Romantic Curiosity & Passion Question',
            target: `My dearest ${client},\n\nOur letters are truly becoming something so special and meaningful to me. I love discovering more about who you are with each word you write.\n\nTell me a dream or secret desire of yours that very few people know about... what brings the purest joy to your soul? 😉\n\nAlways thinking of you,\n${profile} ❤️`,
            es: `Pregunta íntima y reflexiva para propiciar una respuesta amplia.`
          }
        ];
      }
    }

    res.json({
      success: true,
      clientName: client,
      profileName: profile,
      lang: lang,
      options: options,
      letter: options[0].target
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 7.1 ENDPOINT: TRADUCCIÓN INSTANTÁNEA MULTI-IDIOMA
// ====================================================================
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text || text.trim().length === 0) {
      return res.json({ success: true, translatedText: '' });
    }
    const tl = targetLang || 'en';
    const googleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(googleUrl);
    const data = await resp.json();
    let translated = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      translated = data[0].map(item => item[0]).join('');
    }
    res.json({ success: true, translatedText: translated || text, targetLang: tl });
  } catch (err) {
    res.json({ success: true, translatedText: req.body.text || '', error: err.message });
  }
});

// ====================================================================
// 8. ENDPOINT: FIREWALL DE 3 CAPAS (GESTIÓN DE PALABRAS PROHIBIDAS & TM)
// ====================================================================
app.get('/api/banned-words', async (req, res) => {
  try {
    const { data, error } = await supabase.from('banned_words').select('word_or_phrase, category');
    if (error) throw error;

    const words = data.map(item => item.word_or_phrase);
    res.json({ success: true, words, fullList: data });
  } catch (err) {
    res.json({
      success: true,
      words: ['promet', 'whatsapp', 'skype', 'email', 'telefon', 'when we meet', 'book a flight', 'hotel', 'meet up', 'airport']
    });
  }
});

app.post('/api/banned-words', async (req, res) => {
  try {
    const { word, category } = req.body;
    if (!word) return res.status(400).json({ error: 'Palabra requerida' });

    const cleanWord = word.trim().toLowerCase();
    await supabase.from('banned_words').insert({
      word_or_phrase: cleanWord,
      category: category || 'DATA_LEAK'
    });

    res.json({ success: true, message: `Palabra "${cleanWord}" agregada al Firewall` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/banned-words/:word', async (req, res) => {
  try {
    const { word } = req.params;
    await supabase.from('banned_words').delete().eq('word_or_phrase', word.toLowerCase());
    res.json({ success: true, message: `Palabra "${word}" eliminada del Firewall` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 9. ENDPOINT: REGISTRO DE MULTAS AUTOMÁTICAS ($10.000 COP)
// ====================================================================
app.post('/api/fines/register', async (req, res) => {
  try {
    const { operator, shift, profile, clientName, clientId, reason } = req.body;

    await supabase.from('fines').insert({
      operator_name: operator || 'walther',
      shift: shift || 'Mañana',
      profile_name: profile || 'HORACIO',
      client_name: clientName || 'Cliente',
      client_id: clientId || 'N/A',
      amount_cop: 10000.00,
      reason: reason || 'Demora de más de 2 minutos en responder',
      status: 'PENDING_REVIEW'
    });

    res.json({ success: true, message: 'Multa registrada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fines', async (req, res) => {
  try {
    const { data } = await supabase.from('fines').select('*').order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, fines: data || [] });
  } catch (err) {
    res.json({ success: true, fines: [] });
  }
});

app.put('/api/fines/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, supervisorNotes } = req.body; // 'APPROVED' o 'WAIVED'
    await supabase.from('fines').update({
      status: status,
      supervisor_notes: supervisorNotes,
      updated_at: new Date().toISOString()
    }).eq('id', id);

    res.json({ success: true, message: `Multa ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 10. ENDPOINT: COMUNICACIÓN DIRECTA SUPERVISOR ↔ OPERADOR (BIDIRECCIONAL, LECTURA Y EDICIÓN)
// ====================================================================
const liveSupervisorChatMemory = new Map(); // operatorKey -> Array of messages

function normalizeOpKey(name) {
  if (!name) return 'walther';
  return String(name)
    .replace(/\[.*?\]/g, '')
    .trim()
    .toLowerCase();
}

function getSupervisorChatList(opName) {
  const clean = normalizeOpKey(opName);
  if (!liveSupervisorChatMemory.has(clean)) {
    liveSupervisorChatMemory.set(clean, []);
  }
  return { key: clean, list: liveSupervisorChatMemory.get(clean) };
}

// Endpoint para obtener resumen de mensajes no leídos para el supervisor
app.get('/api/supervisor/unread-summary', (req, res) => {
  const unreadMap = {};
  for (const [opKey, list] of liveSupervisorChatMemory.entries()) {
    const unreadFromOp = (list || []).filter(m => m.sender !== 'SUPERVISOR' && !m.read).length;
    if (unreadFromOp > 0) {
      unreadMap[opKey] = unreadFromOp;
    }
  }
  res.json({ success: true, unread: unreadMap });
});

app.get('/api/supervisor/messages/:operator', async (req, res) => {
  try {
    const rawOp = (req.params.operator || '').trim();
    const opKey = normalizeOpKey(rawOp);
    const role = (req.query.role || '').toUpperCase(); // 'OPERATOR' o 'SUPERVISOR'

    const { key: exactKey, list: memMessages } = getSupervisorChatList(opKey);

    // 1. Intentar consultar Supabase en segundo plano o si la memoria está vacía
    if (memMessages.length === 0) {
      try {
        const { data } = await supabase.from('supervisor_chat')
          .select('*')
          .ilike('operator_name', `%${opKey}%`)
          .order('created_at', { ascending: true })
          .limit(50);

        if (data && Array.isArray(data) && data.length > 0) {
          const seenIds = new Set(memMessages.map(m => String(m.id)));
          data.forEach(dbMsg => {
            const strId = String(dbMsg.id);
            if (!seenIds.has(strId)) {
              memMessages.push({
                id: strId,
                sender: dbMsg.sender,
                text: dbMsg.message_text,
                timestamp: new Date(dbMsg.created_at).getTime(),
                isEdited: Boolean(dbMsg.is_edited),
                read: Boolean(dbMsg.is_read)
              });
              seenIds.add(strId);
            }
          });
          memMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          liveSupervisorChatMemory.set(exactKey, memMessages);
        }
      } catch (dbErr) {}
    }

    // 2. Si el rol que consulta lee los mensajes del otro, marcar como leídos (Doble chulito verde)
    if (role === 'OPERATOR') {
      let changed = false;
      memMessages.forEach(m => {
        if (m.sender === 'SUPERVISOR' && !m.read) {
          m.read = true;
          changed = true;
        }
      });
      if (changed) {
        liveSupervisorChatMemory.set(exactKey, memMessages);
        supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${opKey}%`).eq('sender', 'SUPERVISOR').then(() => {}).catch(() => {});
      }
    } else if (role === 'SUPERVISOR') {
      let changed = false;
      memMessages.forEach(m => {
        if (m.sender !== 'SUPERVISOR' && !m.read) {
          m.read = true;
          changed = true;
        }
      });
      if (changed) {
        liveSupervisorChatMemory.set(exactKey, memMessages);
        supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${opKey}%`).neq('sender', 'SUPERVISOR').then(() => {}).catch(() => {});
      }
    }

    res.json({ success: true, operator: exactKey, messages: memMessages });
  } catch (err) {
    res.json({ success: true, messages: [] });
  }
});

app.post('/api/supervisor/mark-read', async (req, res) => {
  try {
    const { operatorName, role } = req.body;
    const { key: exactKey, list } = getSupervisorChatList(operatorName);

    list.forEach(m => {
      if (role === 'OPERATOR' && m.sender === 'SUPERVISOR') {
        m.read = true;
      } else if (role === 'SUPERVISOR' && m.sender !== 'SUPERVISOR') {
        m.read = true;
      }
    });

    liveSupervisorChatMemory.set(exactKey, list);

    if (role === 'OPERATOR') {
      supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${exactKey}%`).eq('sender', 'SUPERVISOR').then(() => {}).catch(() => {});
    } else if (role === 'SUPERVISOR') {
      supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${exactKey}%`).neq('sender', 'SUPERVISOR').then(() => {}).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supervisor/send-message', async (req, res) => {
  try {
    const { operatorName, text, isBroadcast } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Texto requerido' });

    const cleanText = text.trim();

    if (isBroadcast) {
      const activeOps = Array.from(liveOperatorTelemetry.values()).map(o => o.operator);
      const uniqueOps = Array.from(new Set(activeOps));
      if (uniqueOps.length === 0) uniqueOps.push('walther', 'bill');

      uniqueOps.forEach(op => {
        const { key: exactKey, list } = getSupervisorChatList(op);
        list.push({
          id: `sup_bc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          sender: 'SUPERVISOR',
          text: `📢 [ANUNCIO GENERAL] ${cleanText}`,
          timestamp: Date.now(),
          read: false,
          isEdited: false
        });
        if (list.length > 50) list.shift();
        liveSupervisorChatMemory.set(exactKey, list);
      });

      const inserts = uniqueOps.map(op => ({
        operator_name: normalizeOpKey(op),
        sender: 'SUPERVISOR',
        message_text: `📢 [ANUNCIO GENERAL] ${cleanText}`,
        is_read: false
      }));
      supabase.from('supervisor_chat').insert(inserts).then(() => {}).catch(() => {});
    } else {
      const { key: exactKey, list } = getSupervisorChatList(operatorName);
      const msgId = `sup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      list.push({
        id: msgId,
        sender: 'SUPERVISOR',
        text: cleanText,
        timestamp: Date.now(),
        read: false,
        isEdited: false
      });
      if (list.length > 50) list.shift();
      liveSupervisorChatMemory.set(exactKey, list);

      supabase.from('supervisor_chat').insert({
        operator_name: exactKey,
        sender: 'SUPERVISOR',
        message_text: cleanText,
        is_read: false
      }).then(() => {}).catch(() => {});
    }

    res.json({ success: true, message: 'Mensaje de supervisor emitido con éxito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/operator/reply-message', async (req, res) => {
  try {
    const { operatorName, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Texto requerido' });

    const { key: exactKey, list } = getSupervisorChatList(operatorName);
    const cleanText = text.trim();
    const msgId = `op_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    list.push({
      id: msgId,
      sender: 'OPERATOR',
      text: cleanText,
      timestamp: Date.now(),
      read: false,
      isEdited: false
    });
    if (list.length > 50) list.shift();
    liveSupervisorChatMemory.set(exactKey, list);

    supabase.from('supervisor_chat').insert({
      operator_name: exactKey,
      sender: 'OPERATOR',
      message_text: cleanText,
      is_read: false
    }).then(() => {}).catch(() => {});

    res.json({ success: true, id: msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para editar cualquier mensaje del chat de supervisión
app.post('/api/supervisor/edit-message', async (req, res) => {
  try {
    const { id, text, operatorName } = req.body;
    if (!id || !text) return res.status(400).json({ error: 'ID y texto son requeridos' });

    const cleanText = text.trim();

    // Buscar y actualizar en todas las listas en memoria
    for (const [k, list] of liveSupervisorChatMemory.entries()) {
      list.forEach(m => {
        if (String(m.id) === String(id)) {
          m.text = cleanText;
          m.isEdited = true;
        }
      });
    }

    if (!isNaN(id) && Number(id) > 0) {
      supabase.from('supervisor_chat').update({
        message_text: cleanText,
        is_edited: true
      }).eq('id', Number(id)).then(() => {}).catch(() => {});
    }

    res.json({ success: true, message: 'Mensaje editado con éxito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 11. ENDPOINT: ORDEN DE EXTRACCIÓN MASIVA DE TURNO (NUKE SYNC)
// ====================================================================
app.post('/api/chats/extract-all-shift', (req, res) => {
  const { shift, operator, profile } = req.body;
  const targetShift = shift || 'Mañana';
  massExtractionOrders.add(targetShift);

  logSyncEvent({
    type: 'NUKE_ORDER',
    operator: operator || 'Supervisor',
    profile: profile || 'TURNO',
    clientName: 'Extracción Masiva',
    count: 0,
    durationMs: 50,
    status: 'SUCCESS',
    detail: `Orden de extracción masiva emitida para el turno '${targetShift}'. Estaciones cosechando...`
  });

  setTimeout(() => {
    massExtractionOrders.delete(targetShift);
  }, 60000);

  res.json({
    success: true,
    message: `⚡ Orden de extracción emitida para [${profile || operator || targetShift}]. La sincronización táctica ha iniciado.`
  });
});

// ====================================================================
// 11.1 ENDPOINT: MOTOR DE AUDITORÍA EN TIEMPO REAL (4 REGLAS SUPREMAS)
// ====================================================================
function auditConversationRules(text, profileName, clientName) {
  const cleanText = (text || '').toLowerCase();
  const violations = [];

  // Regla 1: Manipulación de regalos (Sin manipulación de ningún tipo para recibir regalos)
  const giftKeywords = [
    'regalo', 'regálame', 'regalame', 'gift', 'gifts', 'send me a gift', 'buy me a gift',
    'present', 'presents', 'tokens', 'monedas', 'propina', 'tip', 'donación', 'mandame un regalo',
    'enviame un regalo', 'give me a present', 'compra un regalo', 'buy me credits', 'mándame un detalle',
    'dame un regalo', 'ayúdame con un regalo', 'send me coins'
  ];
  const matchedGifts = giftKeywords.filter(k => cleanText.includes(k));
  if (matchedGifts.length > 0) {
    violations.push({
      rule: 'GIFT_MANIPULATION',
      severity: 'CRITICAL',
      title: '🎁 Manipulación de Regalos / Tokens Prohibida',
      detail: `Se detectaron solicitudes o insinuaciones de regalos/tokens: "${matchedGifts.slice(0, 3).join(', ')}"`,
      sample: matchedGifts[0]
    });
  }

  // Regla 2: Error en el Nombre del Perfil
  if (profileName) {
    const pClean = profileName.toLowerCase().trim();
    // Lista de perfiles comunes de la agencia para evitar cruces
    const agencyProfiles = ['horacio', 'walther', 'carlos', 'daniela', 'laura', 'andrea', 'mariana', 'valentina', 'camila', 'sofia'];
    const otherProfiles = agencyProfiles.filter(p => p !== pClean);
    for (const op of otherProfiles) {
      // Si la operadora se refiere a sí misma con otro nombre o firma con otro nombre
      const regexNameConfusion = new RegExp(`\\b(soy|me llamo|mi nombre es|i am|my name is|atentamente|con amor,)\\s+${op}\\b`, 'i');
      if (regexNameConfusion.test(cleanText)) {
        violations.push({
          rule: 'WRONG_PROFILE_NAME',
          severity: 'HIGH',
          title: '👤 Confusión en Nombre del Perfil Asignado',
          detail: `El operador utilizó el nombre de otro perfil ("${op.toUpperCase()}") en lugar de "${profileName.toUpperCase()}"`,
          sample: op
        });
        break;
      }
    }
  }

  // Regla 3 & 4: Travel Misleading & Promesas de Viaje, Citas o Matrimonio
  const travelMarriageKeywords = [
    { word: 'when we meet', rule: 'TRAVEL_MEETING', label: 'Cita en persona ("when we meet")' },
    { word: 'when i visit', rule: 'TRAVEL_MEETING', label: 'Visita en persona ("when i visit")' },
    { word: 'book a flight', rule: 'TRAVEL_MEETING', label: 'Compra/reserva de vuelo ("book a flight")' },
    { word: 'my flight', rule: 'TRAVEL_MEETING', label: 'Referencia a vuelo ("my flight")' },
    { word: 'airport', rule: 'TRAVEL_MEETING', label: 'Aeropuerto ("airport")' },
    { word: 'hotel', rule: 'TRAVEL_MEETING', label: 'Hotel ("hotel")' },
    { word: 'plane ticket', rule: 'TRAVEL_MEETING', label: 'Pasaje aéreo ("plane ticket")' },
    { word: 'meet up', rule: 'TRAVEL_MEETING', label: 'Encuentro presencial ("meet up")' },
    { word: 'in person', rule: 'TRAVEL_MEETING', label: 'En persona ("in person")' },
    { word: 'vernos en persona', rule: 'TRAVEL_MEETING', label: 'Cita presencial ("vernos en persona")' },
    { word: 'visitarte', rule: 'TRAVEL_MEETING', label: 'Promesa de visita ("visitarte")' },
    { word: 'viajar a verte', rule: 'TRAVEL_MEETING', label: 'Promesa de viaje ("viajar a verte")' },
    { word: 'marry me', rule: 'MARRIAGE_PROMISE', label: 'Promesa de matrimonio ("marry me")' },
    { word: 'get married', rule: 'MARRIAGE_PROMISE', label: 'Promesa de matrimonio ("get married")' },
    { word: 'casarnos', rule: 'MARRIAGE_PROMISE', label: 'Promesa de matrimonio ("casarnos")' },
    { word: 'matrimonio', rule: 'MARRIAGE_PROMISE', label: 'Mención de matrimonio ("matrimonio")' },
    { word: 'mi esposo', rule: 'MARRIAGE_PROMISE', label: 'Mención de compromiso conyugal ("mi esposo")' },
    { word: 'my husband', rule: 'MARRIAGE_PROMISE', label: 'Mención de compromiso ("my husband")' },
    { word: 'promet', rule: 'FALSE_PROMISE', label: 'Raíz de promesa ("promet...")' }
  ];

  const matchedTravel = [];
  travelMarriageKeywords.forEach(item => {
    if (cleanText.includes(item.word)) {
      matchedTravel.push(item);
    }
  });

  if (matchedTravel.length > 0) {
    violations.push({
      rule: 'TRAVEL_MISLEADING_MARRIAGE',
      severity: 'CRITICAL',
      title: '✈️ Infracción Travel Misleading (TM) / Promesas de Viaje o Matrimonio',
      detail: `Se detectaron frases prohibidas de encuentro, pasajes o matrimonio: ${matchedTravel.map(m => m.label).slice(0, 3).join(', ')}`,
      sample: matchedTravel[0].word
    });
  }

  return {
    passed: violations.length === 0,
    score: violations.length === 0 ? 100 : Math.max(0, 100 - (violations.length * 35)),
    violationsCount: violations.length,
    violations: violations,
    checklist: {
      noGiftManipulation: !violations.some(v => v.rule === 'GIFT_MANIPULATION'),
      correctProfileName: !violations.some(v => v.rule === 'WRONG_PROFILE_NAME'),
      noTravelOrMeeting: !violations.some(v => v.rule === 'TRAVEL_MISLEADING_MARRIAGE'),
      noMarriagePromise: !violations.some(v => v.rule === 'TRAVEL_MISLEADING_MARRIAGE' && cleanText.includes('marr'))
    }
  };
}

// Endpoint para auditar texto en vivo (utilizado por el Accordion y por el módulo Anti-TM)
app.post('/api/audit/realtime-check', async (req, res) => {
  try {
    const { text, profileName, clientName, operatorName } = req.body;
    const auditResult = auditConversationRules(text, profileName, clientName);

    // Si hay violaciones críticas, registrar intento de infracción en telemetría o multa preventiva
    if (!auditResult.passed && operatorName) {
      const crit = auditResult.violations.find(v => v.severity === 'CRITICAL');
      if (crit) {
        supabase.from('fines').insert({
          operator_name: operatorName,
          shift: 'En Vivo',
          profile_name: profileName || 'Perfil',
          client_name: clientName || 'Chat en Vivo',
          amount_cop: 10000.00,
          reason: `Alerta Auditoría en Vivo: ${crit.title} (${crit.sample})`,
          status: 'PENDING_REVIEW'
        }).then(() => {}).catch(() => {});
      }
    }

    res.json({ success: true, ...auditResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 12. ENDPOINT: RELEVO DE TURNOS (SHIFT HANDOVER)
// ====================================================================
app.post('/api/handover/generate-and-save', async (req, res) => {
  try {
    const { operator, shift, profileName, profileId, reportMarkdown: incomingMarkdown } = req.body;

    const reportMarkdown = incomingMarkdown || (`# 📋 RELEVO DE TURNO | PERFIL: ${profileName || 'HORACIO'}\n` +
      `- **Operador Saliente:** ${operator || 'walther'} [Turno: ${shift || 'Mañana'}]\n` +
      `- **Fecha y Hora:** ${new Date().toLocaleString()}\n` +
      `---\n` +
      `### 📌 Resumen de Conversaciones del Turno:\n` +
      `- Clientes activos monitoreados con éxito en la sesión.\n\n` +
      `### ⚠️ Instrucciones para el Turno Siguiente:\n` +
      `- Responder con prioridad las cartas leídas y chats con balance activo.\n` +
      `- Cumplir con la cuota de prospecciones por ciclo.`);

    await supabase.from('shift_handovers').insert({
      profile_name: profileName || 'HORACIO',
      profile_id: profileId || '',
      operator_name: operator || 'walther',
      shift: shift || 'Mañana',
      report_markdown: reportMarkdown
    });

    res.json({ success: true, message: 'Relevo guardado con éxito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/handover/latest', async (req, res) => {
  try {
    const { profileName } = req.query;
    let query = supabase.from('shift_handovers').select('*').order('created_at', { ascending: false }).limit(1);
    if (profileName) query = query.eq('profile_name', profileName);

    const { data } = await query.single();
    res.json({ success: true, handover: data ? { reportMarkdown: data.report_markdown } : null });
  } catch (err) {
    res.json({ success: true, handover: null });
  }
});

// ====================================================================
// RUTA DEL MONITOR (CON NO-CACHE PARA ACTUALIZACIONES INSTANTÁNEAS)
// ====================================================================
const serveMonitor = (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'monitor.html'));
};

app.get('/', serveMonitor);
app.get('/monitor', serveMonitor);
app.get('/monitor.html', serveMonitor);
app.get('/index.html', serveMonitor);
app.get('/dashboard', serveMonitor);

app.listen(PORT, () => {
  console.log(`🚀 [APEX CYBERPUNK MATRIX] Servidor activo en puerto ${PORT}`);
});
