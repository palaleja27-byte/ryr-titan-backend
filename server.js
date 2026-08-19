const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();
const activeAlertsMap = new Map();

// DICCIONARIO DE PALABRAS PROHIBIDAS
let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR HEURÍSTICO PSICOLÓGICO Y CONDUCTUAL
function analyzeConversationBehavior(operator, profile, clientName, clientId, markdown) {
  const alerts = [];
  const textLower = markdown.toLowerCase();

  // A. Coacción y Mendicidad de Regalos / Créditos
  const giftRegex = /(?:si me quisieras|si me amaras|envíame un regalo|mandame un regalo|dame un regalo|cómprame un regalo|regálame algo|pídeme un regalo|send me a gift|give me a gift|if you loved me|buy me a present|send a present|need coins|give me coins)/i;
  if (giftRegex.test(textLower)) {
    alerts.push({
      category: '🛑 Coacción / Manipulación por Regalos',
      severity: 'CRÍTICA',
      snippet: 'Presión al cliente condicionando el afecto a cambio de regalos o monedas.'
    });
  }

  // B. Incomodidad Manifiesta del Cliente (Quejas / Reclamos)
  const complaintRegex = /(?:por qué me hablas así|por que me tratas así|no te acuerdas de mí|olvidaste mi nombre|solo quieres mi dinero|solo te importan los regalos|me estás presionando|me siento incómodo|me siento incomodo|por qué tan cortante|you forgot my name|you are rude|why are you talking to me like that|all you want is money|you don't care about me|stop pressuring me)/i;
  if (complaintRegex.test(textLower)) {
    alerts.push({
      category: '💔 Incomodidad / Reclamo del Cliente',
      severity: 'CRÍTICA',
      snippet: 'El usuario manifestó explícitamente molestia, reclamo o sentirse presionado.'
    });
  }

  // C. Maltrato / Hostilidad / Groserías
  const hostilityRegex = /(?:cállate|callate|no me importa|qué pereza|que pereza|apúrate|apurate|no tengo tiempo|fastidio|pesado|idiota|imbécil|déjame en paz|dejame en paz|shut up|i don't care|stop bothering|waste of time)/i;
  if (hostilityRegex.test(textLower)) {
    alerts.push({
      category: '🚨 Maltrato / Tono Hostil o Cortante',
      severity: 'ALTA',
      snippet: 'Uso de expresiones agresivas, cortantes o de desdén hacia el usuario.'
    });
  }

  // D. Palabras Prohibidas
  for (let word of dynamicBannedWords) {
    if (textLower.includes(word.toLowerCase())) {
      alerts.push({
        category: '🛑 Palabra Prohibida Detectada',
        severity: 'ALTA',
        snippet: `Se detectó la palabra o raíz prohibida: "${word}".`
      });
      break;
    }
  }

  // E. Incoherencia de Nombre
  if (clientName && clientName.length > 2) {
    const cleanClient = clientName.split(',')[0].split(' ')[0].trim().toLowerCase();
    const wrongNameRegex = /(?:hola|hello|dear|querido|querida|hi)\s+([a-záéíóúñ]{3,15})/gi;
    let match;
    while ((match = wrongNameRegex.exec(textLower)) !== null) {
      const mentioned = match[1].toLowerCase();
      const forbiddenNames = ['juan', 'carlos', 'pedro', 'maria', 'luis', 'ana', 'david', 'john', 'peter', 'michael'];
      if (mentioned !== cleanClient && mentioned !== profile.toLowerCase() && forbiddenNames.includes(mentioned)) {
        alerts.push({
          category: '⚠️ Incoherencia de Nombre / Amnesia',
          severity: 'MEDIA',
          snippet: `El operador saludó o llamó al cliente "${mentioned}" cuando su nombre es "${clientName}".`
        });
        break;
      }
    }
  }

  return alerts;
}

// 2. ENDPOINT: TELEMETRÍA EN TIEMPO REAL
app.post('/api/telemetry', (req, res) => {
  const {
    operator, shift, profile, profileId,
    pendingReadLetters, unansweredChatsCount,
    hasExpiredSla, isAfk, idleSeconds, status
  } = req.body;

  if (!operator || !profile) {
    return res.status(400).json({ error: 'Operador y perfil requeridos' });
  }

  const sessionKey = `${operator.toLowerCase().trim()}_${profile.toLowerCase().trim()}`;

  if (status === 'OFFLINE') {
    liveTelemetryMap.delete(sessionKey);
    return res.json({ success: true, message: 'Sesión finalizada' });
  }

  liveTelemetryMap.set(sessionKey, {
    operatorName: operator.trim(),
    shift: shift || 'Mañana',
    profileName: profile.trim(),
    profileId: profileId || 'N/A',
    pendingReadLetters: parseInt(pendingReadLetters, 10) || 0,
    unansweredChatsCount: parseInt(unansweredChatsCount, 10) || 0,
    hasExpiredSla: Boolean(hasExpiredSla),
    isAfk: Boolean(isAfk),
    idleSeconds: parseInt(idleSeconds, 10) || 0,
    lastSeen: Date.now()
  });

  res.json({ success: true });
});

// 3. ENDPOINT: AUDITORÍA HEURÍSTICA Y GUARDADO INCREMENTAL EN SUPABASE
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;

  if (!profile || !clientId || !markdown) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const auditKey = `${profile}_${clientId}`;
  const behaviorAlerts = analyzeConversationBehavior(operator, profile, clientName, clientId, markdown);

  // Registrar alertas en cola activa
  behaviorAlerts.forEach((alert, index) => {
    const alertId = `${auditKey}_${index}_${Date.now()}`;
    const alertEntry = {
      id: alertId,
      auditId: auditKey,
      operatorName: operator || 'Desconocido',
      profileName: profile,
      clientName: clientName || 'Cliente',
      clientId: clientId,
      category: alert.category,
      severity: alert.severity,
      snippet: alert.snippet,
      markdown: markdown,
      status: 'PENDING',
      timestamp: Date.now()
    };

    activeAlertsMap.set(alertId, alertEntry);

    if (SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/chat_alerts`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: alertId,
          operator_name: alertEntry.operatorName,
          shift: 'Activo',
          profile_name: alertEntry.profileName,
          client_name: alertEntry.clientName,
          client_id: alertEntry.clientId,
          category: alertEntry.category,
          severity: alertEntry.severity,
          snippet: alertEntry.snippet,
          markdown: alertEntry.markdown,
          status: 'PENDING'
        })
      }).catch(() => {});
    }
  });

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: clientName || 'Cliente',
    client_id: clientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: behaviorAlerts.map(a => a.category),
    has_breach: behaviorAlerts.length > 0,
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(auditKey, {
    ...auditPayload,
    operator: auditPayload.operator_name,
    profile: auditPayload.profile_name,
    clientName: auditPayload.client_name,
    clientId: auditPayload.client_id,
    timestamp: Date.now()
  });

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true, alertsCount: behaviorAlerts.length, flags: auditPayload.flags });
});

// 4. ENDPOINTS DE GESTIÓN DE ALERTAS (ATENDER / DESCARTAR)
app.get('/api/alerts/live', (req, res) => {
  const alertsList = Array.from(activeAlertsMap.values())
    .filter(a => a.status === 'PENDING')
    .sort((a, b) => b.timestamp - a.timestamp);
  res.json({ success: true, alerts: alertsList });
});

app.post('/api/alerts/:id/resolve', (req, res) => {
  const alertId = req.params.id;
  if (activeAlertsMap.has(alertId)) {
    activeAlertsMap.get(alertId).status = 'RESOLVED';
  }
  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_alerts?id=eq.${alertId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'RESOLVED' })
    }).catch(() => {});
  }
  res.json({ success: true });
});

app.post('/api/alerts/:id/dismiss', (req, res) => {
  const alertId = req.params.id;
  activeAlertsMap.delete(alertId);
  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_alerts?id=eq.${alertId}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    }).catch(() => {});
  }
  res.json({ success: true });
});

// 5. OBTENER AUDITORÍAS DE CHATS DESDE SUPABASE O RAM
app.get('/api/chats/audits', async (req, res) => {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?select=*&order=updated_at.desc&limit=60`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        const formatted = data.map(d => ({
          id: d.id,
          operator: d.operator_name,
          profile: d.profile_name,
          clientName: d.client_name,
          clientId: d.client_id,
          flags: Array.isArray(d.flags) ? d.flags : [],
          hasBreach: d.has_breach,
          markdown: d.markdown,
          timestamp: new Date(d.updated_at).getTime()
        }));
        return res.json({ success: true, audits: formatted });
      }
    } catch (e) {}
  }
  const fallback = Array.from(recentChatAuditsRAM.values()).sort((a, b) => b.timestamp - a.timestamp);
  res.json({ success: true, audits: fallback });
});

// 6. PALABRAS PROHIBIDAS
app.get('/api/banned-words', (req, res) => {
  res.json({ words: Array.from(dynamicBannedWords) });
});

app.post('/api/banned-words', (req, res) => {
  const { word } = req.body;
  if (word && word.trim().length > 1) {
    dynamicBannedWords.add(word.trim().toLowerCase());
  }
  res.json({ success: true, words: Array.from(dynamicBannedWords) });
});

app.post('/api/banned-words/delete', (req, res) => {
  const { word } = req.body;
  if (word) {
    dynamicBannedWords.delete(word.trim().toLowerCase());
  }
  res.json({ success: true, words: Array.from(dynamicBannedWords) });
});

// 7. CONSOLIDADO EN VIVO PARA EL MONITOR
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();

  for (const [key, data] of liveTelemetryMap.entries()) {
    if (now - data.lastSeen > 35000) {
      liveTelemetryMap.delete(key);
    } else {
      const opKey = data.operatorName.toLowerCase();
      if (!operatorsMap.has(opKey)) {
        operatorsMap.set(opKey, {
          operatorName: data.operatorName,
          shift: data.shift,
          lastSeen: data.lastSeen,
          isAfkGlobal: false,
          hasExpiredSlaGlobal: false,
          totalLetters: 0,
          profiles: []
        });
      }

      const opEntry = operatorsMap.get(opKey);
      opEntry.profiles.push({
        profileName: data.profileName,
        profileId: data.profileId,
        pendingReadLetters: data.pendingReadLetters,
        unansweredChatsCount: data.unansweredChatsCount,
        hasExpiredSla: data.hasExpiredSla,
        isAfk: data.isAfk,
        idleSeconds: data.idleSeconds
      });

      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }

  res.json({
    success: true,
    operators: Array.from(operatorsMap.values())
  });
});

// 8. DASHBOARD EMBEBIDO CON VISOR INTELIGENTE DE AUDITORÍA
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RYR TITAN APEX - COMMAND & AUDIT CENTER</title>
  <style>
    :root {
      --bg-main: #060913;
      --bg-card: #0e1526;
      --bg-card-hover: #151f38;
      --accent-green: #10b981;
      --accent-cyan: #00ffcc;
      --accent-orange: #f59e0b;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-color: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: var(--bg-main); color: var(--text-main); font-family: system-ui, -apple-system, sans-serif; padding: 12px; }
    
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid var(--border-color); border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .brand-title { font-size: 14px; font-weight: 900; letter-spacing: 1.5px; color: var(--accent-cyan); }
    .metrics-bar { display: flex; gap: 8px; align-items: center; }
    
    .metric-pill { background: #1c2541; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: bold; border: 1px solid #3a506b; display: flex; align-items: center; gap: 6px; }
    .metric-pill.danger { border-color: var(--accent-red); color: var(--accent-red); background: rgba(239, 68, 68, 0.15); animation: pulse 1.5s infinite; }
    .metric-pill.afk-pill { border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168, 85, 247, 0.15); }
    
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .btn-action.active { border-color: var(--accent-green); color: var(--accent-green); background: rgba(16,185,129,0.1); }
    .btn-alert-hub { background: rgba(239, 68, 68, 0.2); border-color: var(--accent-red); color: #f87171; animation: pulse 1.2s infinite; }

    .filters-bar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .filter-btn { background: #1c2541; color: var(--text-muted); border: 1px solid var(--border-color); padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .filter-btn.active, .filter-btn:hover { background: var(--accent-green); color: #000; border-color: var(--accent-green); }
    
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; position: relative; transition: 0.2s; }
    .operator-card.in-breach { border-color: var(--accent-red) !important; box-shadow: 0 0 16px rgba(239, 68, 68, 0.4); animation: pulse 1s infinite; }
    .operator-card.is-afk { border-color: var(--accent-purple) !important; box-shadow: 0 0 16px rgba(168, 85, 247, 0.3); }
    
    .operator-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; margin-bottom: 10px; }
    .operator-name { font-size: 13px; font-weight: 800; color: #fff; }
    .shift-tag { font-size: 10px; background: #1e293b; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
    
    .profiles-list { display: flex; flex-direction: column; gap: 8px; }
    .profile-item { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; }
    .profile-item.alert-profile { border-color: var(--accent-red); background: rgba(239, 68, 68, 0.08); }
    
    .profile-name { font-size: 12px; font-weight: 700; color: var(--accent-cyan); }
    .profile-stats { display: flex; gap: 8px; font-size: 11px; margin-top: 2px; }
    .stat-letters { color: #38bdf8; font-weight: bold; }
    
    .stat-sla { font-weight: bold; padding: 2px 6px; border-radius: 4px; font-size: 10px; }
    .stat-sla.ok { background: #064e3b; color: #34d399; }
    .stat-sla.breach { background: #7f1d1d; color: #fca5a5; animation: pulse 1s infinite; }
    .stat-sla.afk { background: #581c87; color: #d8b4fe; }

    /* MODAL DE ALERTAS Y AUDITORÍA */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.88); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 920px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 10px; font-weight: 800; color: var(--accent-cyan); }
    .modal-body { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
    
    .alert-card { background: #060913; border: 1px solid var(--accent-red); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
    .alert-card-header { display: flex; justify-content: space-between; align-items: center; }
    .alert-category { font-size: 13px; font-weight: 900; color: #f87171; }
    .alert-meta { font-size: 11px; color: var(--text-muted); }
    .alert-snippet { background: rgba(239, 68, 68, 0.12); border-left: 3px solid #ef4444; padding: 8px 12px; border-radius: 4px; font-size: 12px; color: #fca5a5; font-weight: bold; }
    .alert-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
    
    .btn-resolve { background: #064e3b; color: #34d399; border: 1px solid #10b981; padding: 6px 14px; border-radius: 5px; font-size: 11px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-resolve:hover { background: #10b981; color: #060913; }
    .btn-dismiss { background: #450a0a; color: #f87171; border: 1px solid #ef4444; padding: 6px 14px; border-radius: 5px; font-size: 11px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-dismiss:hover { background: #ef4444; color: #fff; }

    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; line-height: 1.6; color: #cbd5e1; }

    .banned-tags-container { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .banned-tag { background: #1c2541; border: 1px solid #ef4444; color: #fca5a5; padding: 4px 8px; border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 6px; }
    .banned-tag span { cursor: pointer; font-weight: bold; color: #fff; }

    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
  </style>
</head>
<body>

  <header>
    <div class="brand-title">⚡ RYR TITAN APEX - AUDITORÍA & SUPERVISIÓN LIVE</div>
    <div class="metrics-bar">
      <div class="metric-pill">👥 Ops: <span id="total-operators">0</span></div>
      <div class="metric-pill">✉️ Cartas: <span id="total-letters">0</span></div>
      <div id="afk-pill" class="metric-pill afk-pill" style="display:none;">💤 Inactivos: <span id="total-afk">0</span></div>
      <div id="alert-pill" class="metric-pill danger" style="display:none;">🚨 Alertas SLA: <span id="total-alerts">0</span></div>
      <button id="btn-alert-center" class="btn-action btn-alert-hub" onclick="openAlertsCenterModal()">🚨 Alertas de Conducta (<span id="count-behavior-alerts">0</span>)</button>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
      <button id="btn-sound" class="btn-action" onclick="toggleAudio()">🔇 Sonido: OFF</button>
    </div>
  </header>

  <div class="filters-bar">
    <span style="font-size: 11px; color: var(--text-muted); font-weight: bold;">TURNO:</span>
    <button class="filter-btn active" onclick="setShiftFilter('ALL')">TODOS</button>
    <button class="filter-btn" onclick="setShiftFilter('Mañana')">Mañana</button>
    <button class="filter-btn" onclick="setShiftFilter('Tarde')">Tarde</button>
    <button class="filter-btn" onclick="setShiftFilter('Noche')">Noche</button>
    <button class="filter-btn" onclick="setShiftFilter('Trasnocho')">Trasnocho</button>
  </div>

  <div id="operators-grid" class="grid-operators"></div>

  <!-- MODAL 1: CENTRO DE ALERTAS CONDUCTUALES -->
  <div id="modal-alerts-hub" class="modal-overlay">
    <div class="modal-content">
      <div class="modal-header">
        <span>🚨 CENTRO DE ALERTAS: MANIPULACIÓN, MALTRATO & INCOHERENCIAS</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div class="modal-body" id="alerts-hub-list">
        <p style="color:var(--text-muted);">No hay alertas de conducta pendientes en este momento.</p>
      </div>
    </div>
  </div>

  <!-- MODAL 2: HISTORIAL DE CHATS EN MARKDOWN (ESTRUCTURADO Y LIMPIO) -->
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div class="modal-header">
        <span>📄 AUDITORÍA HISTÓRICA DE DIÁLOGOS (MARKDOWN SIN DUPLICADOS)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-search-audit" oninput="filterAudits()" placeholder="Buscar por operador, perfil, ID de usuario o cliente..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
      </div>
      <div class="modal-body" id="chat-audits-list">
        <p style="color:var(--text-muted);">Cargando transcripciones desde Supabase...</p>
      </div>
    </div>
  </div>

  <!-- MODAL 3: GESTOR DE PALABRAS PROHIBIDAS -->
  <div id="modal-banned" class="modal-overlay">
    <div class="modal-content" style="width:600px;">
      <div class="modal-header">
        <span>🛡️ FIREWALL EN TIEMPO REAL: PALABRAS PROHIBIDAS</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-new-word" placeholder="Nueva palabra prohibida..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
        <button class="btn-action" style="background:#10b981; color:#000;" onclick="addBannedWord()">+ Agregar</button>
      </div>
      <div class="modal-body">
        <div id="banned-words-list" class="banned-tags-container"></div>
      </div>
    </div>
  </div>

  <script>
    let activeFilter = 'ALL';
    let soundEnabled = false;
    let audioCtx = null;
    let globalAuditsCache = [];
    const API_URL = window.location.origin;

    function toggleAudio() {
      soundEnabled = !soundEnabled;
      const btn = document.getElementById('btn-sound');
      if (soundEnabled) {
        btn.innerText = '🔊 Sonido: ON';
        btn.classList.add('active');
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        playBeep(600, 0.1);
      } else {
        btn.innerText = '🔇 Sonido: OFF';
        btn.classList.remove('active');
      }
    }

    function playBeep(freq = 880, duration = 0.2) {
      if (!soundEnabled) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch (e) {}
    }

    function setShiftFilter(shift) {
      activeFilter = shift;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.innerText.includes(shift) || (shift === 'ALL' && btn.innerText === 'TODOS'));
      });
      fetchLiveTelemetry();
    }

    async function fetchLiveTelemetry() {
      try {
        const res = await fetch(\`\${API_URL}/api/telemetry/live\`);
        const data = await res.json();
        renderDashboard(data.operators || []);
        fetchBehaviorAlertsCount();
      } catch (err) {}
    }

    async function fetchBehaviorAlertsCount() {
      try {
        const res = await fetch(\`\${API_URL}/api/alerts/live\`);
        const data = await res.json();
        const count = data.alerts ? data.alerts.length : 0;
        document.getElementById('count-behavior-alerts').innerText = count;
        if (count > 0) playBeep(920, 0.3);
      } catch (e) {}
    }

    function renderDashboard(operatorsList) {
      const grid = document.getElementById('operators-grid');
      grid.innerHTML = '';
      let globalLetters = 0, globalAlerts = 0, globalAfk = 0;

      const filtered = operatorsList.filter(op => activeFilter === 'ALL' || op.shift === activeFilter);

      filtered.forEach(op => {
        let opHasBreach = op.hasExpiredSlaGlobal;
        let opIsAfk = op.isAfkGlobal;
        let profilesHtml = '';
        globalLetters += op.totalLetters;
        if (opIsAfk) globalAfk++;

        op.profiles.forEach(p => {
          if (p.hasExpiredSla) globalAlerts++;
          let slaClass = p.hasExpiredSla ? 'breach' : (p.isAfk ? 'afk' : 'ok');
          let slaText = p.hasExpiredSla ? '🚨 +2 MIN' : (p.isAfk ? \`💤 \${Math.floor(p.idleSeconds/60)}m AFK\` : '⏱️ AL DÍA');

          profilesHtml += \`
            <div class="profile-item \${p.hasExpiredSla ? 'alert-profile' : ''}">
              <div>
                <span class="profile-name">🎯 \${p.profileName}</span>
                <div class="profile-stats">
                  <span class="stat-letters">✉️ \${p.pendingReadLetters || 0} cartas</span>
                  \${p.unansweredChatsCount > 0 ? \`<span style="color:#f59e0b;">💬 \${p.unansweredChatsCount}</span>\` : ''}
                </div>
              </div>
              <span class="stat-sla \${slaClass}">\${slaText}</span>
            </div>\`;
        });

        const card = document.createElement('div');
        card.className = \`operator-card \${opHasBreach ? 'in-breach' : ''} \${opIsAfk ? 'is-afk' : ''}\`;
        card.innerHTML = \`
          <div class="operator-header">
            <span class="operator-name">👤 \${op.operatorName} (\${op.profiles.length} Perfiles)</span>
            <span class="shift-tag">\${op.shift}</span>
          </div>
          <div class="profiles-list">\${profilesHtml}</div>
          <div style="font-size:9px; color:var(--text-muted); margin-top:6px; text-align:right;">Activo hace \${Math.floor((Date.now() - op.lastSeen) / 1000)}s</div>\`;
        grid.appendChild(card);
      });

      document.getElementById('total-operators').innerText = filtered.length;
      document.getElementById('total-letters').innerText = globalLetters;

      const alertPill = document.getElementById('alert-pill');
      if (globalAlerts > 0) {
        alertPill.style.display = 'flex';
        document.getElementById('total-alerts').innerText = globalAlerts;
      } else {
        alertPill.style.display = 'none';
      }

      const afkPill = document.getElementById('afk-pill');
      if (globalAfk > 0) {
        afkPill.style.display = 'flex';
        document.getElementById('total-afk').innerText = globalAfk;
      } else {
        afkPill.style.display = 'none';
      }
    }

    // MODAL CENTRO DE ALERTAS
    async function openAlertsCenterModal() {
      document.getElementById('modal-alerts-hub').style.display = 'flex';
      const container = document.getElementById('alerts-hub-list');
      container.innerHTML = '<p>Cargando alertas de conducta...</p>';
      
      const res = await fetch(\`\${API_URL}/api/alerts/live\`);
      const data = await res.json();

      if (!data.alerts || data.alerts.length === 0) {
        container.innerHTML = '<p style="color:#10b981; font-weight:bold;">✅ Excelente: No hay alertas de conducta pendientes de atención.</p>';
        return;
      }

      container.innerHTML = data.alerts.map(a => \`
        <div class="alert-card" id="card-alert-\${a.id}">
          <div class="alert-card-header">
            <span class="alert-category">\${a.category}</span>
            <span class="alert-meta">👤 Op: <b>\${a.operatorName}</b> | 🎯 Perfil: <b>\${a.profileName}</b> | 💬 Cliente: <b>\${a.clientName} (ID: \${a.clientId})</b></span>
          </div>
          <div class="alert-snippet">⚠️ Motivo: \${a.snippet}</div>
          <div class="chat-transcript">\${a.markdown}</div>
          <div class="alert-actions">
            <button class="btn-resolve" onclick="resolveAlert('\${a.id}')">✅ Atender / Resolver</button>
            <button class="btn-dismiss" onclick="dismissAlert('\${a.id}')">🗑️ Ignorar / Descartar</button>
          </div>
        </div>
      \`).join('');
    }

    async function resolveAlert(alertId) {
      await fetch(\`\${API_URL}/api/alerts/\${alertId}/resolve\`, { method: 'POST' });
      document.getElementById(\`card-alert-\${alertId}\`)?.remove();
      fetchBehaviorAlertsCount();
    }

    async function dismissAlert(alertId) {
      await fetch(\`\${API_URL}/api/alerts/\${alertId}/dismiss\`, { method: 'POST' });
      document.getElementById(\`card-alert-\${alertId}\`)?.remove();
      fetchBehaviorAlertsCount();
    }

    // MODAL AUDITORÍA HISTÓRICA CON ID DE USUARIO
    async function openChatAuditsModal() {
      document.getElementById('modal-chats').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/chats/audits\`);
      const data = await res.json();
      globalAuditsCache = data.audits || [];
      renderAuditsList(globalAuditsCache);
    }

    function renderAuditsList(audits) {
      const container = document.getElementById('chat-audits-list');
      if (audits.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);">No hay conversaciones en Supabase aún. Haz clic en "⚡" en Talkytimes.</p>';
        return;
      }

      container.innerHTML = audits.map(a => {
        const flagHtml = a.flags.map(f => \`<span class="metric-pill">\${f}</span>\`).join('');
        const blob = new Blob([a.markdown], { type: 'text/markdown' });
        const downloadUrl = URL.createObjectURL(blob);

        return \`
          <div class="alert-card" style="border-color:#1e293b;">
            <div class="alert-card-header">
              <span style="font-size:12px; font-weight:bold; color:var(--accent-cyan);">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (ID: \${a.clientId})</span>
              <a href="\${downloadUrl}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">\${flagHtml}</div>
            <div class="chat-transcript">\${a.markdown}</div>
          </div>
        \`;
      }).join('');
    }

    function filterAudits() {
      const query = document.getElementById('input-search-audit').value.toLowerCase();
      const filtered = globalAuditsCache.filter(a => 
        a.operator.toLowerCase().includes(query) ||
        a.profile.toLowerCase().includes(query) ||
        a.clientName.toLowerCase().includes(query) ||
        String(a.clientId).toLowerCase().includes(query)
      );
      renderAuditsList(filtered);
    }

    // MODAL PALABRAS PROHIBIDAS
    async function openBannedWordsModal() {
      document.getElementById('modal-banned').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/banned-words\`);
      const data = await res.json();
      renderBannedTags(data.words || []);
    }

    function renderBannedTags(words) {
      const container = document.getElementById('banned-words-list');
      container.innerHTML = words.map(w => \`
        <div class="banned-tag">
          <span>\${w}</span>
          <span onclick="deleteBannedWord('\${w}')">✕</span>
        </div>
      \`).join('');
    }

    async function addBannedWord() {
      const input = document.getElementById('input-new-word');
      const word = input.value.trim();
      if (!word) return;
      const res = await fetch(\`\${API_URL}/api/banned-words\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
      });
      const data = await res.json();
      input.value = '';
      renderBannedTags(data.words || []);
    }

    async function deleteBannedWord(word) {
      const res = await fetch(\`\${API_URL}/api/banned-words/delete\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
      });
      const data = await res.json();
      renderBannedTags(data.words || []);
    }

    function closeModals() {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    }

    setInterval(fetchLiveTelemetry, 2000);
    fetchLiveTelemetry();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor.html', (req, res) => res.send(DASHBOARD_HTML));

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND V6.0 activo en puerto ${PORT}`);
});
