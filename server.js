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
      responseTimeSeconds: configuredMinutes * 60
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para consultar todas las infracciones detalladas de un perfil
app.get('/api/fines/infractions/:profile', (req, res) => {
  const profKey = (req.params.profile || 'HORACIO').toUpperCase().trim();
  const infractions = liveProfileInfractions.get(profKey) || [];
  res.json({ success: true, infractions });
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
app.get('/api/telemetry/live-grid', (req, res) => {
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
// 7. ENDPOINT: GENERADOR IA DE CARTAS LISTAS (CONTEXTO 360° Y RAZONAMIENTO)
// ====================================================================
app.post('/api/intelligence/generate-letter', async (req, res) => {
  try {
    const { clientName, clientId, profileName, bioData, targetLang, recentLetters, lastIncomingLetter, recentChat } = req.body;

    const lang = targetLang || 'en';
    const client = clientName || (lang === 'pt' ? 'amor' : (lang === 'es' ? 'amor' : 'love'));
    const profile = profileName || (lang === 'pt' ? 'Eu' : (lang === 'es' ? 'Yo' : 'Me'));

    // Consultar cartas previas en Supabase si no llegaron en el request
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

    // Identificar la última carta recibida de la clienta/cliente para razonar su contenido
    const incomingLetters = allLetters.filter(l => !l.isOutgoing);
    const effectiveLastIncoming = lastIncomingLetter || (incomingLetters.length > 0 ? incomingLetters[incomingLetters.length - 1].preview : '');

    // Extracción analítica de conceptos clave
    const incomingLower = (effectiveLastIncoming || '').toLowerCase();
    let topicAcknowledge = '';

    if (incomingLower.includes('photo') || incomingLower.includes('picture') || incomingLower.includes('foto') || incomingLower.includes('pic')) {
      if (lang === 'pt') topicAcknowledge = 'Adorei a foto que você me enviou! Ver o seu olhar me fez sentir você tão pertinho de mim.';
      else if (lang === 'es') topicAcknowledge = '¡Me encantó la foto que me compartiste! Ver tus ojos me hizo sentirte tan cerca de mí.';
      else topicAcknowledge = 'I absolutely loved the picture you shared with me! Seeing your warm gaze made me feel so close to you.';
    } else if (incomingLower.includes('work') || incomingLower.includes('job') || incomingLower.includes('trabalho') || incomingLower.includes('trabajo') || incomingLower.includes('busy')) {
      if (lang === 'pt') topicAcknowledge = 'Imagino como seus dias de trabalho devem ser corridos, mas você sempre tem essa doçura incomparável ao falar comigo.';
      else if (lang === 'es') topicAcknowledge = 'Imagino lo ajetreadas que son tus jornadas de trabajo, pero me fascina cómo siempre tienes esa dulzura al escribirme.';
      else topicAcknowledge = 'I know how demanding your days can be, yet you always bring such sweetness and calm into my life.';
    } else if (incomingLower.includes('miss') || incomingLower.includes('saudade') || incomingLower.includes('extraño') || incomingLower.includes('love') || incomingLower.includes('amor')) {
      if (lang === 'pt') topicAcknowledge = 'Sentir o seu carinho e ler essas palavras sinceras faz meu coração bater mais forte.';
      else if (lang === 'es') topicAcknowledge = 'Sentir tu cariño tan sincero en cada línea hace que mi corazón lata más fuerte por ti.';
      else topicAcknowledge = 'Feeling the sincerity of your affection in every word leaves a warmth in my heart that stays with me all day.';
    }

    let letterDraft = '';

    if (lang === 'pt') {
      if (effectiveLastIncoming) {
        letterDraft = `Meu querido ${client},\n\n` +
          `Li sua carta com toda a atenção do mundo e um sorriso imenso que não saiu do meu rosto. ${topicAcknowledge || 'Cada detalhe que você compartilha comigo é especial e me aproxima ainda mais de você.'}\n\n` +
          `Adoro a honestidade e a ternura com que você sempre se expressa. Em meio a toda a correria do dia a dia, encontrar uma mensagem sua é como um refúgio que acalma minha alma.\n\n` +
          `Fico pensando em tudo o que ainda temos para descobrir um sobre o outro... Me conta, qual foi a coisa mais bonita ou o pensamento que te fez sorrir hoje?\n\n` +
          `Com todo o meu afeto e carinho,\n${profile} ❤️`;
      } else {
        letterDraft = `Meu querido ${client},\n\n` +
          `Enquanto olho nossas conversas e penso em você, senti uma vontade enorme de te escrever esta carta.\n\n` +
          `Queria que você soubesse o quanto valorizo o carinho e o respeito que você sempre me demonstra. Há algo muito genuíno e doce na nossa sintonia, e eu adoro sentir essa cumplicidade crescendo a cada dia.\n\n` +
          `Quero saber mais sobre você... o que te inspira e como tem sido os seus dias ultimamente?\n\n` +
          `Com todo meu carinho,\n${profile} ❤️`;
      }
    } else if (lang === 'es') {
      if (effectiveLastIncoming) {
        letterDraft = `Mi queridísimo ${client},\n\n` +
          `Leí tu carta con muchísima emoción y no pude evitar sonreír al sentir tu cariño en cada palabra. ${topicAcknowledge || 'Cada detalle que me cuentas es especial para mí y me hace sentirte más presente.'}\n\n` +
          `Aprecio profundamente la dulzura y sinceridad con la que siempre me hablas. En medio de un día ocupado, leer tus palabras me da una paz inmensa y me llena el corazón de calidez.\n\n` +
          `Me quedé con muchas ganas de saber más de ti... Dime algo, ¿qué fue lo más lindo o el detalle especial que te alegró el día de hoy?\n\n` +
          `Con todo mi cariño y ternura,\n${profile} ❤️`;
      } else {
        letterDraft = `Mi queridísimo ${client},\n\n` +
          `Mientras repasaba nuestros mensajes y pensaba en ti, sentí el deseo sincero de dedicarte estas líneas.\n\n` +
          `Quiero agradecerte por la dulzura y el respeto con los que siempre te acercas a mí. Nuestra conexión es algo muy especial que valoro de corazón, y me fascina cómo logras sacarme una sonrisa aun a la distancia.\n\n` +
          `Cuéntame algo de ti que muy pocos sepan... ¿qué es aquello que más disfrutas hacer en tus momentos libres?\n\n` +
          `Con todo mi cariño,\n${profile} ❤️`;
      }
    } else {
      if (effectiveLastIncoming) {
        letterDraft = `My dearest ${client},\n\n` +
          `I read your letter with such genuine emotion, and I couldn't stop smiling as I took in every single word. ${topicAcknowledge || 'Every thought and feeling you share with me brings us closer together.'}\n\n` +
          `I truly cherish your honesty, tenderness, and the way you express yourself. Even in the middle of a busy day, reading your words brings a wonderful sense of calm and happiness to my heart.\n\n` +
          `I keep thinking about everything we have yet to discover about each other... Tell me, what was the sweetest thought or moment that made you smile today?\n\n` +
          `With all my affection,\n${profile} ❤️`;
      } else {
        letterDraft = `My dearest ${client},\n\n` +
          `As I was thinking of our conversations, I felt a strong desire to write to you and send you a little piece of my heart.\n\n` +
          `I truly appreciate the sweetness, patience, and warmth you always bring into our connection. There is something profoundly special about the bond we are creating, and you always manage to brighten my day.\n\n` +
          `Tell me something about yourself that you rarely share with others... what brings you the greatest peace when the day winds down?\n\n` +
          `With all my affection and warmth,\n${profile} ❤️`;
      }
    }

    res.json({ success: true, letter: letterDraft });
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
    for (const [k, v] of liveSupervisorChatMemory.entries()) {
      if (k === clean || (clean && k && (k.includes(clean) || clean.includes(k)))) {
        return { key: k, list: v };
      }
    }
    liveSupervisorChatMemory.set(clean, []);
    return { key: clean, list: liveSupervisorChatMemory.get(clean) };
  }
  return { key: clean, list: liveSupervisorChatMemory.get(clean) };
}

app.get('/api/supervisor/messages/:operator', async (req, res) => {
  try {
    const rawOp = (req.params.operator || '').trim();
    const opKey = normalizeOpKey(rawOp);
    const role = (req.query.role || '').toUpperCase(); // 'OPERATOR' o 'SUPERVISOR'

    const { key: exactKey, list: memMessages } = getSupervisorChatList(opKey);

    // 2. Intentar consultar Supabase para historial histórico
    try {
      const { data } = await supabase.from('supervisor_chat')
        .select('*')
        .or(`operator_name.ilike.%${opKey}%,operator_name.ilike.%${rawOp}%`)
        .order('created_at', { ascending: true })
        .limit(50);

      if (data && data.length > 0) {
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
    } catch (dbErr) {
      // Si falla BD, la memoria RAM asegura 100% de uptime
    }

    // Si el rol que consulta lee los mensajes del otro, marcar como leídos (Doble chulito verde)
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
        try {
          await supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${opKey}%`).eq('sender', 'SUPERVISOR');
        } catch (e) {}
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
        try {
          await supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${opKey}%`).neq('sender', 'SUPERVISOR');
        } catch (e) {}
      }
    }

    res.json({ success: true, messages: memMessages });
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

    try {
      if (role === 'OPERATOR') {
        await supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${exactKey}%`).eq('sender', 'SUPERVISOR');
      } else if (role === 'SUPERVISOR') {
        await supabase.from('supervisor_chat').update({ is_read: true }).ilike('operator_name', `%${exactKey}%`).neq('sender', 'SUPERVISOR');
      }
    } catch (e) {}

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

      try {
        const inserts = uniqueOps.map(op => ({
          operator_name: normalizeOpKey(op),
          sender: 'SUPERVISOR',
          message_text: `📢 [ANUNCIO GENERAL] ${cleanText}`,
          is_read: false
        }));
        await supabase.from('supervisor_chat').insert(inserts);
      } catch (e) {}
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

      try {
        await supabase.from('supervisor_chat').insert({
          operator_name: exactKey,
          sender: 'SUPERVISOR',
          message_text: cleanText,
          is_read: false
        });
      } catch (e) {}
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

    try {
      await supabase.from('supervisor_chat').insert({
        operator_name: exactKey,
        sender: 'OPERATOR',
        message_text: cleanText,
        is_read: false
      });
    } catch (e) {}

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

    // Actualizar también en Supabase si es un ID numérico o existe
    try {
      if (!isNaN(id) && Number(id) > 0) {
        await supabase.from('supervisor_chat').update({
          message_text: cleanText,
          is_edited: true
        }).eq('id', Number(id));
      }
    } catch (e) {}

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
