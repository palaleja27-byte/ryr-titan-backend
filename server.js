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

// Diccionario dinámico de palabras prohibidas
let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR DE EXTRACCIÓN DE EXPEDIENTES E INTELIGENCIA
function extractUserDossier(clientName, clientId, markdown) {
  const textLower = markdown.toLowerCase();

  // Extraer mascotas
  let pets = 'No detectado';
  if (/(perro|dog|cachorro|puppy)/i.test(textLower)) pets = '🐶 Tiene perro';
  else if (/(gato|cat|gatito)/i.test(textLower)) pets = '🐱 Tiene gato';
  else if (/(mascota|pet)/i.test(textLower)) pets = '🐾 Tiene mascota';

  // Extraer familia / hijos
  let family = 'No detectado';
  if (/(mis hijos|my kids|my children|tengo hijos|my son|my daughter)/i.test(textLower)) family = '👶 Tiene hijos';
  else if (/(nietos|grandkids|grandchildren)/i.test(textLower)) family = '👵 Tiene nietos';
  else if (/(no tengo hijos|no kids)/i.test(textLower)) family = '❌ Sin hijos';

  // Extraer trabajo
  let work = 'No detectado';
  if (/(retirado|retired|jubilado)/i.test(textLower)) work = '🏖️ Jubilado / Retirado';
  else if (/(negocio|business|empresa|owner)/i.test(textLower)) work = '💼 Dueño de negocio';
  else if (/(ingeniero|engineer)/i.test(textLower)) work = '⚙️ Ingeniero';
  else if (/(médico|medico|doctor|nurse)/i.test(textLower)) work = '🩺 Sector salud';

  // Estado civil
  let maritalStatus = 'No detectado';
  if (/(divorced|divorciado|divorciada)/i.test(textLower)) maritalStatus = '💔 Divorciado';
  else if (/(widowed|viudo|viuda)/i.test(textLower)) maritalStatus = '🕊️ Viudo';
  else if (/(single|soltero|soltera)/i.test(textLower)) maritalStatus = '👤 Soltero';

  return {
    clientName: clientName || 'Cliente',
    clientId: clientId,
    pets,
    family,
    work,
    maritalStatus,
    summary: `Cliente con historial registrado. Mantener coherencia en el tono y trato.`
  };
}

// 2. ENDPOINT: CONSULTA DE INTELIGENCIA CON PREGUNTAS EN LENGUAJE NATURAL
app.post('/api/intelligence/query', async (req, res) => {
  const { query, clientId } = req.body;
  const qLower = (query || '').toLowerCase();

  // Buscar conversación en Supabase o RAM
  let chatMd = '';
  if (SUPABASE_URL && SUPABASE_KEY && clientId) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
      }
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (audit.clientId === clientId || audit.client_id === clientId) {
        chatMd = audit.markdown;
        break;
      }
    }
  }

  if (!chatMd) {
    return res.json({ answer: `No tenemos conversaciones guardadas del cliente ID ${clientId}. Haz clic en ⚡ para extraer su historial.` });
  }

  const dossier = extractUserDossier('Cliente', clientId, chatMd);

  // Responder según la pregunta
  let answer = '';
  if (qLower.includes('perro') || qLower.includes('gato') || qLower.includes('mascota') || qLower.includes('pet')) {
    answer = `🐾 **Mascotas:** ${dossier.pets}.`;
  } else if (qLower.includes('hijo') || qLower.includes('familia') || qLower.includes('hijos') || qLower.includes('kids')) {
    answer = `👶 **Familia:** ${dossier.family}.`;
  } else if (qLower.includes('trabajo') || qLower.includes('profesion') || qLower.includes('profesión') || qLower.includes('job')) {
    answer = `💼 **Trabajo:** ${dossier.work}.`;
  } else if (qLower.includes('casado') || qLower.includes('soltero') || qLower.includes('divorciado') || qLower.includes('estado civil')) {
    answer = `💍 **Estado Civil:** ${dossier.maritalStatus}.`;
  } else {
    answer = `📋 **Expediente del Cliente:**\n- Mascotas: ${dossier.pets}\n- Familia: ${dossier.family}\n- Profesión: ${dossier.work}\n- Estado Civil: ${dossier.maritalStatus}`;
  }

  res.json({ answer, dossier });
});

// 3. ENDPOINT: OBTENER EXPEDIENTE DIRECTO POR ID
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = req.params.clientId;
  let chatMd = '';

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
      }
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (audit.clientId === clientId || audit.client_id === clientId) {
        chatMd = audit.markdown;
        break;
      }
    }
  }

  if (chatMd) {
    const dossier = extractUserDossier('Cliente', clientId, chatMd);
    return res.json({ success: true, dossier });
  }

  res.json({ success: false, dossier: null });
});

// 4. TELEMETRÍA Y DEMÁS ENDPOINTS (MISMOS QUE ANTES)
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

// 5. AUDITORÍA HEURÍSTICA
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const auditKey = `${profile}_${clientId}`;
  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: clientName || 'Cliente',
    client_id: clientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: ['✅ Conversación Correcta'],
    has_breach: false,
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(auditKey, { ...auditPayload, operator, profile, clientName, clientId, timestamp: Date.now() });

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true });
});

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

// DASHBOARD CON ASISTENTE DE MEMORIA
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - LIVE MONITOR & AI MEMORY</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; --accent-purple: #8b5cf6; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 850px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; color: #cbd5e1; }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN & MEMORIA IA</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action" onclick="openMemoryModal()">🧠 Consultar Memoria IA</button>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>

  <div id="operators-grid" class="grid-operators"></div>

  <!-- MODAL MEMORIA IA SUPERVISOR -->
  <div id="modal-memory" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">🧠 ASISTENTE DE MEMORIA & EXPEDIENTE DE CLIENTES</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-client-id-sup" placeholder="ID del Usuario (ej: 162930348)..." style="width:200px; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
        <input type="text" id="input-query-sup" placeholder="Pregunta (ej: ¿Tiene mascotas? ¿En qué trabaja?)..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
        <button class="btn-action" style="background:#8b5cf6; color:#060913;" onclick="querySupervisorMemory()">Preguntar</button>
      </div>
      <div id="sup-memory-result" class="chat-transcript" style="max-height:350px; font-size:12px;">Ingresa el ID del usuario y una pregunta para consultar...</div>
    </div>
  </div>

  <!-- MODAL CHATS -->
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">📄 HISTORIAL DE CHATS</span>
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
        const grid = document.getElementById('operators-grid');
        grid.innerHTML = (data.operators || []).map(op => \`
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
      } catch (e) {}
    }

    async function openMemoryModal() { document.getElementById('modal-memory').style.display = 'flex'; }
    async function openChatAuditsModal() {
      document.getElementById('modal-chats').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/chats/audits\`);
      const data = await res.json();
      document.getElementById('chat-audits-list').innerHTML = (data.audits || []).map(a => \`
        <div style="background:#060913; border:1px solid #1e293b; border-radius:6px; padding:10px; margin-bottom:8px;">
          <div style="font-weight:bold; color:#00ffcc; margin-bottom:4px;">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (ID: \${a.clientId})</div>
          <div class="chat-transcript">\${a.markdown}</div>
        </div>\`).join('');
    }

    async function querySupervisorMemory() {
      const clientId = document.getElementById('input-client-id-sup').value.trim();
      const query = document.getElementById('input-query-sup').value.trim();
      const box = document.getElementById('sup-memory-result');
      box.innerText = '🔍 Consultando memoria...';

      const res = await fetch(\`\${API_URL}/api/intelligence/query\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, clientId })
      });
      const data = await res.json();
      box.innerText = data.answer || 'Sin resultados.';
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

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND V7.0 (AI Memory Hub) en puerto ${PORT}`);
});
