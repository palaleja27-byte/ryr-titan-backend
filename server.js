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
const syncedClientsRegistry = new Set();

let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR HEURÍSTICO AVANZADO DE PATRONES CONDUCTUALES
function analyzeConversationPatterns(operator, profile, clientName, clientId, markdown) {
  const alerts = [];
  const textLower = markdown.toLowerCase();

  // A. Coacción y Mendicidad de Regalos
  const giftRegex = /(?:si me quisieras|si me amaras|envíame un regalo|mandame un regalo|dame un regalo|cómprame un regalo|regálame algo|pídeme un regalo|send me a gift|give me a gift|if you loved me|buy me a present|send a present|need coins|give me coins)/i;
  if (giftRegex.test(textLower)) {
    alerts.push({
      category: '🛑 Coacción / Pedir Regalos',
      severity: 'CRÍTICA',
      snippet: 'El operador está condicionando el afecto o exigiendo regalos/créditos.'
    });
  }

  // B. Incomodidad / Reclamos del Cliente
  const complaintRegex = /(?:por qué me hablas así|por que me tratas así|no te acuerdas de mí|olvidaste mi nombre|solo quieres mi dinero|solo te importan los regalos|me estás presionando|me siento incómodo|me siento incomodo|por qué tan cortante|you forgot my name|you are rude|why are you talking to me like that|all you want is money|you don't care about me|stop pressuring me)/i;
  if (complaintRegex.test(textLower)) {
    alerts.push({
      category: '💔 Incomodidad / Reclamo del Cliente',
      severity: 'CRÍTICA',
      snippet: 'El cliente manifestó queja, molestia o sentirse ignorado/maltratado.'
    });
  }

  // C. Tono Hostil o Grosero
  const hostilityRegex = /(?:cállate|callate|no me importa|qué pereza|que pereza|apúrate|apurate|no tengo tiempo|fastidio|pesado|idiota|imbécil|déjame en paz|dejame en paz|shut up|i don't care|stop bothering|waste of time)/i;
  if (hostilityRegex.test(textLower)) {
    alerts.push({
      category: '🚨 Tono Hostil / Maltrato',
      severity: 'ALTA',
      snippet: 'Uso de expresiones cortantes o de desprecio hacia el usuario.'
    });
  }

  // D. Palabras Prohibidas
  for (let word of dynamicBannedWords) {
    if (textLower.includes(word.toLowerCase())) {
      alerts.push({
        category: '🛑 Palabra Prohibida Detectada',
        severity: 'ALTA',
        snippet: `Se detectó la palabra prohibida: "${word}".`
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
          snippet: `El operador saludó a "${mentioned}" cuando el usuario se llama "${clientName}".`
        });
        break;
      }
    }
  }

  return alerts;
}

// 2. ENDPOINT: VERIFICAR CHATS GUARDADOS EN SUPABASE
app.get('/api/chats/synced-ids', async (req, res) => {
  const profile = req.query.profile;
  const syncedSet = new Set(syncedClientsRegistry);

  if (SUPABASE_URL && SUPABASE_KEY && profile) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?profile_name=eq.${profile}&select=client_id`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) {
        data.forEach(d => syncedSet.add(String(d.client_id).trim()));
      }
    } catch (e) {}
  }

  res.json({ success: true, syncedIds: Array.from(syncedSet) });
});

// 3. ENDPOINT: AUDITORÍA HEURÍSTICA Y GUARDADO
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;

  if (!profile || !clientId || !markdown) {
    return res.status(400).json({ error: 'Incompleto' });
  }

  const cleanClientId = String(clientId).trim();
  const auditKey = `${profile}_${cleanClientId}`;
  syncedClientsRegistry.add(cleanClientId);

  const detectedAlerts = analyzeConversationPatterns(operator, profile, clientName, cleanClientId, markdown);

  // Registrar alertas en cola activa
  detectedAlerts.forEach((alert, index) => {
    const alertId = `${auditKey}_${index}_${Date.now()}`;
    const alertEntry = {
      id: alertId,
      auditId: auditKey,
      operatorName: operator || 'Desconocido',
      profileName: profile,
      clientName: clientName || 'Cliente',
      clientId: cleanClientId,
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
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(alertEntry)
      }).catch(() => {});
    }
  });

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: clientName || 'Cliente',
    client_id: cleanClientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: detectedAlerts.map(a => a.category),
    has_breach: detectedAlerts.length > 0,
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(auditKey, { ...auditPayload, operator, profile, clientName, clientId: cleanClientId, timestamp: Date.now() });

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true, clientId: cleanClientId, flags: auditPayload.flags });
});

// 4. ENDPOINT: FORZAR ANÁLISIS MANUAL DE UN CHAT ESPECÍFICO
app.post('/api/chats/analyze-single', (req, res) => {
  const { operator, profile, clientName, clientId, markdown } = req.body;
  const detectedAlerts = analyzeConversationPatterns(operator, profile, clientName, clientId, markdown);
  res.json({ success: true, alerts: detectedAlerts });
});

// 5. GESTIÓN DE ALERTAS (RESOLVER Y BORRAR)
app.get('/api/alerts/live', (req, res) => {
  const alertsList = Array.from(activeAlertsMap.values()).filter(a => a.status === 'PENDING').sort((a, b) => b.timestamp - a.timestamp);
  res.json({ success: true, alerts: alertsList });
});

app.post('/api/alerts/:id/resolve', (req, res) => {
  const alertId = req.params.id;
  if (activeAlertsMap.has(alertId)) activeAlertsMap.get(alertId).status = 'RESOLVED';
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

// 6. OBTENER AUDITORÍAS DE CHATS DESDE SUPABASE
app.get('/api/chats/audits', async (req, res) => {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?select=*&order=updated_at.desc&limit=60`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        return res.json({ success: true, audits: data.map(d => ({ id: d.id, operator: d.operator_name, profile: d.profile_name, clientName: d.client_name, clientId: d.client_id, flags: d.flags || [], markdown: d.markdown, timestamp: new Date(d.updated_at).getTime() })) });
      }
    } catch (e) {}
  }
  res.json({ success: true, audits: Array.from(recentChatAuditsRAM.values()) });
});

// 7. TELEMETRÍA Y CONTROL
app.post('/api/telemetry', (req, res) => {
  const { operator, shift, profile, profileId, pendingReadLetters, unansweredChatsCount, hasExpiredSla, isAfk, idleSeconds, status } = req.body;
  if (!operator || !profile) return res.status(400).json({ error: 'Faltan datos' });

  const sessionKey = `${operator.toLowerCase().trim()}_${profile.toLowerCase().trim()}`;
  if (status === 'OFFLINE') {
    liveTelemetryMap.delete(sessionKey);
    return res.json({ success: true });
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

app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();
  for (const [key, data] of liveTelemetryMap.entries()) {
    if (now - data.lastSeen > 35000) {
      liveTelemetryMap.delete(key);
    } else {
      const opKey = data.operatorName.toLowerCase();
      if (!operatorsMap.has(opKey)) {
        operatorsMap.set(opKey, { operatorName: data.operatorName, shift: data.shift, lastSeen: data.lastSeen, isAfkGlobal: false, hasExpiredSlaGlobal: false, totalLetters: 0, profiles: [] });
      }
      const opEntry = operatorsMap.get(opKey);
      opEntry.profiles.push({ profileName: data.profileName, profileId: data.profileId, pendingReadLetters: data.pendingReadLetters, unansweredChatsCount: data.unansweredChatsCount, hasExpiredSla: data.hasExpiredSla, isAfk: data.isAfk, idleSeconds: data.idleSeconds });
      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }
  res.json({ success: true, operators: Array.from(operatorsMap.values()) });
});

app.get('/api/banned-words', (req, res) => res.json({ words: Array.from(dynamicBannedWords) }));
app.post('/api/banned-words', (req, res) => { if (req.body.word) dynamicBannedWords.add(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });
app.post('/api/banned-words/delete', (req, res) => { if (req.body.word) dynamicBannedWords.delete(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });

// 8. DASHBOARD EMBEBIDO CON VISOR DE AUDITORÍA Y ANALIZADOR
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - AUDITORÍA & SUPERVISIÓN LIVE</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.88); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 920px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; line-height: 1.6; color: #cbd5e1; }
    .alert-card { background: #060913; border: 1px solid var(--accent-red); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - AUDITORÍA & SUPERVISIÓN LIVE</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action" style="border-color:#ef4444; color:#f87171;" onclick="openAlertsCenterModal()">🚨 Alertas de Conducta (<span id="count-behavior-alerts">0</span>)</button>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>

  <div id="operators-grid" class="grid-operators"></div>

  <!-- MODAL ALERTAS -->
  <div id="modal-alerts-hub" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">🚨 CENTRO DE ALERTAS CONDUCTUALES (SUPABASE)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="alerts-hub-list" style="overflow-y:auto; flex:1;"></div>
    </div>
  </div>

  <!-- MODAL AUDITORÍA DE CHATS CON ANALIZADOR MANUAL -->
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">📄 AUDITORÍA HISTÓRICA DE DIÁLOGOS (ID REAL EXTRAÍDO)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="chat-audits-list" style="overflow-y:auto; flex:1;"></div>
    </div>
  </div>

  <!-- MODAL BANNED -->
  <div id="modal-banned" class="modal-overlay">
    <div class="modal-content" style="width:550px;">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">🛡️ PALABRAS PROHIBIDAS</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-new-word" placeholder="Nueva palabra..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px;">
        <button class="btn-action" style="background:#10b981; color:#000;" onclick="addBannedWord()">+ Agregar</button>
      </div>
      <div id="banned-words-list" style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;"></div>
    </div>
  </div>

  <script>
    const API_URL = window.location.origin;

    async function fetchLive() {
      try {
        const res = await fetch(\`\${API_URL}/api/telemetry/live\`);
        const data = await res.json();
        document.getElementById('operators-grid').innerHTML = (data.operators || []).map(op => \`
          <div class="operator-card">
            <div style="display:flex; justify-content:space-between; font-weight:bold; border-bottom:1px solid #1e293b; padding-bottom:6px; margin-bottom:8px;">
              <span>👤 \${op.operatorName} (\${op.profiles.length} Perfiles)</span>
              <span style="font-size:10px; color:#38bdf8;">\${op.shift}</span>
            </div>
            \${op.profiles.map(p => \`
              <div style="background:#060913; border:1px solid #1e293b; border-radius:6px; padding:6px 8px; margin-bottom:6px; display:flex; justify-content:space-between;">
                <span>🎯 \${p.profileName}</span>
                <span style="font-size:11px; color:#38bdf8;">✉️ \${p.pendingReadLetters} cartas</span>
              </div>\`).join('')}
          </div>
        \`).join('');
        fetchAlertsCount();
      } catch (e) {}
    }

    async function fetchAlertsCount() {
      try {
        const res = await fetch(\`\${API_URL}/api/alerts/live\`);
        const data = await res.json();
        document.getElementById('count-behavior-alerts').innerText = data.alerts ? data.alerts.length : 0;
      } catch (e) {}
    }

    async function openAlertsCenterModal() {
      document.getElementById('modal-alerts-hub').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/alerts/live\`);
      const data = await res.json();
      const container = document.getElementById('alerts-hub-list');
      if (!data.alerts || data.alerts.length === 0) {
        container.innerHTML = '<p style="color:#10b981;">✅ No hay alertas de conducta pendientes.</p>';
        return;
      }
      container.innerHTML = data.alerts.map(a => \`
        <div class="alert-card" id="alert-item-\${a.id}">
          <div style="display:flex; justify-content:space-between; font-weight:bold; color:#f87171;">
            <span>\${a.category}</span>
            <span style="font-size:11px; color:#94a3b8;">👤 \${a.operatorName} | 🎯 \${a.profileName} | 💬 \${a.clientName} (ID: \${a.clientId})</span>
          </div>
          <div style="margin:6px 0; color:#fca5a5; font-size:12px;">⚠️ \${a.snippet}</div>
          <div class="chat-transcript">\${a.markdown}</div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
            <button class="btn-action" style="background:#064e3b; color:#34d399;" onclick="resolveAlert('\${a.id}')">✅ Revisar / Atender</button>
            <button class="btn-action" style="background:#450a0a; color:#f87171;" onclick="dismissAlert('\${a.id}')">🗑️ Borrar</button>
          </div>
        </div>
      \`).join('');
    }

    async function resolveAlert(id) { await fetch(\`\${API_URL}/api/alerts/\${id}/resolve\`, { method: 'POST' }); document.getElementById('alert-item-' + id)?.remove(); fetchAlertsCount(); }
    async function dismissAlert(id) { await fetch(\`\${API_URL}/api/alerts/\${id}/dismiss\`, { method: 'POST' }); document.getElementById('alert-item-' + id)?.remove(); fetchAlertsCount(); }

    async function openChatAuditsModal() {
      document.getElementById('modal-chats').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/chats/audits\`);
      const data = await res.json();
      const container = document.getElementById('chat-audits-list');
      if (!data.audits || data.audits.length === 0) {
        container.innerHTML = '<p style="color:#94a3b8;">No hay conversaciones en Supabase aún. Presiona ⚡ en Talkytimes.</p>';
        return;
      }
      container.innerHTML = data.audits.map(a => \`
        <div style="background:#060913; border:1px solid #1e293b; border-radius:6px; padding:12px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-weight:bold; color:var(--accent-cyan);">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (ID: \${a.clientId})</span>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" style="border-color:#f59e0b; color:#fbbf24;" onclick="triggerManualAudit('\${a.operator}', '\${a.profile}', '\${a.clientName}', '\${a.clientId}', decodeURIComponent('\${encodeURIComponent(a.markdown)}'))">🔍 Analizar Patrones</button>
              <a href="data:text/markdown;charset=utf-8,\${encodeURIComponent(a.markdown)}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
            </div>
          </div>
          <div class="chat-transcript" id="transcript-\${a.clientId}">\${a.markdown}</div>
        </div>
      \`).join('');
    }

    async function triggerManualAudit(operator, profile, clientName, clientId, markdown) {
      const res = await fetch(\`\${API_URL}/api/chats/analyze-single\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operator, profile, clientName, clientId, markdown })
      });
      const data = await res.json();
      if (data.alerts && data.alerts.length > 0) {
        alert(\`🚨 Se detectaron \${data.alerts.length} alertas:\\n- \` + data.alerts.map(al => al.category + ': ' + al.snippet).join('\\n- '));
      } else {
        alert('✅ Conversación limpia: No se detectaron patrones de maltrato, palabras prohibidas ni mendicidad de regalos.');
      }
    }

    async function openBannedWordsModal() {
      document.getElementById('modal-banned').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/banned-words\`);
      const data = await res.json();
      document.getElementById('banned-words-list').innerHTML = (data.words || []).map(w => \`
        <div style="background:#1c2541; border:1px solid #ef4444; color:#fca5a5; padding:3px 6px; border-radius:4px; font-size:11px;">
          \${w} <span style="cursor:pointer; font-weight:bold; margin-left:4px;" onclick="delWord('\${w}')">✕</span>
        </div>\`).join('');
    }

    async function addBannedWord() {
      const word = document.getElementById('input-new-word').value.trim();
      if (!word) return;
      await fetch(\`\${API_URL}/api/banned-words\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word }) });
      document.getElementById('input-new-word').value = '';
      openBannedWordsModal();
    }

    async function delWord(word) {
      await fetch(\`\${API_URL}/api/banned-words/delete\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word }) });
      openBannedWordsModal();
    }

    function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none'); }

    setInterval(fetchLive, 2000);
    fetchLive();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor.html', (req, res) => res.send(DASHBOARD_HTML));

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V9.0 activo en puerto ${PORT}`));
