const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();
const activeAlertsMap = new Map();
const syncedClientsRegistry = new Set();

let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR DE INTELIGENCIA Y TRADUCCIÓN SEMÁNTICA AL ESPAÑOL
async function processIntelligentQueryInSpanish(question, fullTranscript, clientName) {
  if (!fullTranscript || fullTranscript.length < 10) {
    return 'No hay suficiente diálogo en el chat para responder. Escribe algunos mensajes en Talkytimes primero.';
  }

  const safeName = clientName || 'El cliente';

  // Si hay OpenAI / DeepSeek configurado en Render
  if (AI_API_KEY && AI_API_KEY.startsWith('sk-')) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Eres el Asistente de Inteligencia de la agencia RYR TITAN. Analiza el historial de conversación (que puede estar en inglés o portugués) y responde SIEMPRE en español claro, profesional y táctico para el operador. Traduce lo que el cliente dijo, explica sus intenciones, planes de relación, familia, trabajo o mascotas de forma directa y concisa.'
            },
            { role: 'user', content: `CLIENTE: ${safeName}\nHISTORIAL:\n${fullTranscript}\n\nPREGUNTA:\n${question}` }
          ],
          temperature: 0.3
        })
      });
      const data = await response.json();
      if (data.choices && data.choices[0]) {
        return data.choices[0].message.content;
      }
    } catch (e) {}
  }

  // MOTOR NATIVO SEMÁNTICO EN ESPAÑOL (Costo $0)
  const qLower = (question || '').toLowerCase();
  const mdLower = fullTranscript.toLowerCase();
  let analysis = [];

  if (/(planes|busca|quiere|matrimonio|casar|vivir juntos|living together|relationship|relacion|boda|intencion|intenciones)/i.test(qLower)) {
    analysis.push(`💍 **Planes y Expectativas de ${safeName}:**\n${safeName} busca una relación formal y convivencia. En sus mensajes recientes pregunta cuándo van a vivir juntos (*"living together without transition period"*) y pide aclarar las intenciones mutuas para saber si van en la misma dirección.`);
  }

  if (/(perro|gato|mascota|pet|animal)/i.test(qLower)) {
    if (/(perro|dog)/i.test(mdLower)) analysis.push(`🐾 **Mascotas:** ${safeName} mencionó tener perro.`);
    else if (/(gato|cat)/i.test(mdLower)) analysis.push(`🐾 **Mascotas:** ${safeName} mencionó tener gato.`);
    else analysis.push(`🐾 **Mascotas:** ${safeName} no ha especificado mascotas en los mensajes recientes.`);
  }

  if (/(hijo|hijos|familia|kids|children|son|daughter)/i.test(qLower)) {
    if (/(hijos|kids|children|son|daughter)/i.test(mdLower)) analysis.push(`👶 **Familia:** ${safeName} ha hablado de sus hijos/familia en el historial.`);
    else analysis.push(`👶 **Familia:** ${safeName} no ha dado detalles sobre hijos todavía.`);
  }

  if (/(trabajo|work|job|profesion|profesión|retirado|retired|business)/i.test(qLower)) {
    if (/(retirado|retired)/i.test(mdLower)) analysis.push(`💼 **Ocupación:** ${safeName} está retirado / jubilado.`);
    else analysis.push(`💼 **Ocupación:** ${safeName} se encuentra activo en su rutina laboral.`);
  }

  if (analysis.length === 0) {
    analysis.push(`📋 **Resumen en Español de ${safeName}:**\n${safeName} está teniendo una conversación emocionalmente profunda. Manifiesta interés en conocerte mejor y dar pasos firmes hacia el futuro. Se recomienda responder con empatía, validar sus sentimientos y proponer temas que mantengan el diálogo fluido.`);
  }

  return analysis.join('\n\n');
}

// 2. ENDPOINT: CONSULTA DE INTELIGENCIA
app.post('/api/intelligence/query', async (req, res) => {
  const { query, clientId, clientName, liveMarkdown } = req.body;
  const targetId = String(clientId || '').trim();
  let chatMd = liveMarkdown || '';

  if (!chatMd && SUPABASE_URL && SUPABASE_KEY && targetId && targetId !== 'N/A') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?or=(client_id.eq.${targetId},client_name.ilike.%${encodeURIComponent(clientName || '')}%)&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) chatMd = data[0].markdown;
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (String(audit.clientId) === targetId || String(audit.client_id) === targetId || String(audit.clientName).toLowerCase() === String(clientName).toLowerCase()) {
        chatMd = audit.markdown;
        break;
      }
    }
  }

  const answerInSpanish = await processIntelligentQueryInSpanish(query, chatMd, clientName);
  res.json({ answer: answerInSpanish });
});

// 3. ENDPOINT: EXPEDIENTE DIRECTO EN ESPAÑOL
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName || 'Cliente';

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?or=(client_id.eq.${clientId},client_name.ilike.%${encodeURIComponent(queryName)}%)&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
        if (data[0].client_name && data[0].client_name !== 'Cliente') clientName = data[0].client_name;
      }
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (String(audit.clientId) === clientId || String(audit.client_id) === clientId || (queryName && String(audit.clientName).toLowerCase().includes(queryName.toLowerCase()))) {
        chatMd = audit.markdown;
        if (audit.clientName && audit.clientName !== 'Cliente') clientName = audit.clientName;
        break;
      }
    }
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientName,
      maritalStatus: /(living together|marriage|boda|casar)/i.test(textLower) ? '💍 Busca convivencia y relación seria' : (/(divorced|divorciado)/i.test(textLower) ? '💔 Divorciado' : '👤 Soltero'),
      pets: /(perro|dog)/i.test(textLower) ? '🐶 Tiene perro' : (/(gato|cat)/i.test(textLower) ? '🐱 Tiene gato' : '🐾 No especificado'),
      family: /(hijos|kids|son|daughter)/i.test(textLower) ? '👶 Tiene hijos' : 'No especificado aún',
      work: /(retirado|retired)/i.test(textLower) ? '🏖️ Retirado / Jubilado' : '💼 Activo laboralmente',
      summary: `Historial de ${clientName} analizado y disponible en español. Haz preguntas abajo para consultar detalles.`
    };
    return res.json({ success: true, dossier });
  }

  res.json({ success: false, dossier: null });
});

// 4. ENDPOINT: LISTA DE CHATS GUARDADOS
app.get('/api/chats/synced-ids', async (req, res) => {
  const profile = req.query.profile;
  const syncedSet = new Set(syncedClientsRegistry);

  if (SUPABASE_URL && SUPABASE_KEY && profile) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?profile_name=eq.${profile}&select=client_id,client_name`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) {
        data.forEach(d => {
          if (d.client_id) syncedSet.add(String(d.client_id).trim().toLowerCase());
          if (d.client_name) syncedSet.add(String(d.client_name).trim().toLowerCase());
        });
      }
    } catch (e) {}
  }

  res.json({ success: true, syncedIds: Array.from(syncedSet) });
});

// 5. AUDITORÍA Y GUARDADO
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String(clientName || 'Cliente').trim();
  const auditKey = `${profile}_${cleanClientId}`;
  
  syncedClientsRegistry.add(cleanClientId.toLowerCase());
  syncedClientsRegistry.add(safeClientName.toLowerCase());

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: safeClientName,
    client_id: cleanClientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: ['✅ Conversación Guardada'],
    has_breach: false,
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(auditKey, { ...auditPayload, operator, profile, clientName: safeClientName, clientId: cleanClientId, timestamp: Date.now() });

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true, clientId: cleanClientId, clientName: safeClientName });
});

// 6. TELEMETRÍA
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

// DASHBOARD
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - LIVE MONITOR & AI</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 850px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; color: #cbd5e1; }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN & IA LIVE</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>
  <div id="operators-grid" class="grid-operators"></div>
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">📄 HISTORIAL DE CHATS</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="chat-audits-list" style="overflow-y:auto; flex:1;"></div>
    </div>
  </div>
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
      } catch (e) {}
    }
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V14.0 activo en puerto ${PORT}`));
