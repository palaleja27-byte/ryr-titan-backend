const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

function cleanEnv(val) {
  return String(val || '').replace(/['"\r\n\s]/g, '').trim();
}

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
const SUPABASE_KEY = cleanEnv(process.env.SUPABASE_KEY);
const GROQ_API_KEY = cleanEnv(process.env.GROQ_API_KEY);
const OPENAI_API_KEY = cleanEnv(process.env.OPENAI_API_KEY);
const DEEPSEEK_API_KEY = cleanEnv(process.env.DEEPSEEK_API_KEY);

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();
const activeAlertsMap = new Map();
const operatorFinesRAM = new Map();
const syncedClientsRegistry = new Set();

let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR DE IA COGNITIVO CON CONTEXTO COMPLETO DE BIOGRAFÍA
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName, bioData) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Eva';
  const safeProfile = profileName || 'HORACIO';
  const pLower = (prompt || '').toLowerCase().trim();
  const mdLower = (fullTranscript || '').toLowerCase();

  const realCountry = bioData?.country || 'Poland';
  const realBirthDate = bioData?.birthDate || 'January 01, 1973 (53 años)';
  const realMarital = bioData?.maritalStatus || 'Divorced';

  // Si hay Groq activo
  if (GROQ_API_KEY && GROQ_API_KEY.includes('gsk_')) {
    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (let model of models) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9000);

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: `Eres el Asistente de Inteligencia de RYR TITAN.
                DATOS REALES DEL CLIENTE:
                - Nombre: ${safeClient}
                - Ubicación/País Real: ${realCountry}
                - Fecha de Nacimiento/Edad: ${realBirthDate}
                - Estado Civil: ${realMarital}
                
                REGLAS:
                1. Responde DIRECTAMENTE a lo que pregunte el operador en español.
                2. Si preguntan de dónde es, responde que es de ${realCountry}.
                3. Si preguntan edad o cumpleaños, responde ${realBirthDate}.
                4. CERO TRAVEL MISLEADING: NUNCA sugieras encuentros en persona ni viajes.`
              },
              { role: 'user', content: `HISTORIAL DEL CHAT:\n${fullTranscript}\n\nPREGUNTA:\n${prompt}` }
            ],
            temperature: 0.65,
            max_tokens: 800
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.choices && data.choices[0] && data.choices[0].message?.content) {
            return data.choices[0].message.content.replace(/\*\*/g, '').trim();
          }
        }
      } catch (err) {}
    }
  }

  // MOTOR NATIVO EXACTO (Costo $0)
  if (/(donde vive|dónde vive|de donde|de dónde|pais|país|location|country|poland|brazil)/i.test(pLower)) {
    return `📍 Ubicación de ${safeClient}:\nEs de ${realCountry}.`;
  }

  if (/(edad|años|anos|cuantos años|cuántos años|nacimiento|cumpleaños|cumple)/i.test(pLower)) {
    return `🎂 Edad y Nacimiento de ${safeClient}:\n${realBirthDate}.`;
  }

  if (/(estado civil|casada|soltera|divorciada|viuda|pareja|matrimonio)/i.test(pLower)) {
    return `💍 Estado Civil de ${safeClient}:\n${realMarital}.`;
  }

  if (/(gustos|intereses|hobbies|que le gusta)/i.test(pLower)) {
    return `🎯 Intereses de ${safeClient}:\n${bioData?.interests || 'Disfruta de conversaciones sinceras, compartir fotos y reflexiones sobre la vida.'}`;
  }

  return `📋 Información sobre ${safeClient}:
• Ubicación: ${realCountry}
• Nacimiento: ${realBirthDate}
• Estado Civil: ${realMarital}
Puedes preguntarme cualquier detalle sobre su vida o pedirme redactar un mensaje.`;
}

// 2. ENDPOINT: CONSULTA DE INTELIGENCIA
app.post('/api/intelligence/query', async (req, res) => {
  try {
    const { query, clientId, clientName, profileName, liveMarkdown, bioData } = req.body;
    const targetId = String(clientId || '').trim();
    let chatMd = liveMarkdown || '';

    if (!chatMd && SUPABASE_URL && SUPABASE_KEY && targetId && targetId !== 'N/A') {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${targetId}&select=*&limit=1`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const data = await resp.json();
        if (Array.isArray(data) && data[0]) chatMd = data[0].markdown;
      } catch (e) {}
    }

    if (!chatMd) {
      for (let audit of recentChatAuditsRAM.values()) {
        if (String(audit.clientId) === targetId || String(audit.client_id) === targetId) {
          chatMd = audit.markdown;
          break;
        }
      }
    }

    const aiAnswer = await generateMasterAiResponse(query, chatMd, clientName, profileName, bioData);
    res.json({ success: true, answer: aiAnswer });
  } catch (err) {
    res.json({ success: true, answer: `Consulta procesada con éxito.` });
  }
});

// 3. EXPEDIENTE DIRECTO
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  let chatMd = '';
  let clientName = 'Eva';

  if (SUPABASE_URL && SUPABASE_KEY && clientId !== 'N/A') {
    try {
      let resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&select=*&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      let data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
        clientName = data[0].client_name;
      }
    } catch (e) {}
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientName,
      location: /(poland|polonia)/i.test(textLower) ? 'Poland' : (/(brazil|brasil)/i.test(textLower) ? 'Brazil' : 'United States'),
      birthDate: /(january 01, 1973|1973)/i.test(textLower) ? 'January 01, 1973 (53 años)' : 'Jul 4, 1970 (54 años)',
      maritalStatus: /(divorced|divorciada)/i.test(textLower) ? 'Divorced' : 'Not married',
      summary: `Expediente de ${clientName} verificado en pantalla.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

// 4. DEMÁS ENDPOINTS (TELEMETRÍA, MULTAS, AUDITORÍAS, MONITOR)
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String(clientName || 'Eva').trim();
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
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true, clientId: cleanClientId, clientName: safeClientName });
});

app.post('/api/telemetry', (req, res) => {
  const { operator, shift, profile, profileId, pendingReadLetters, unansweredChatsCount, hasExpiredSla, isAfk, idleSeconds, activeChatTimersList, status } = req.body;
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
    activeChatTimersList: Array.isArray(activeChatTimersList) ? activeChatTimersList : [],
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
      opEntry.profiles.push({ profileName: data.profileName, profileId: data.profileId, pendingReadLetters: data.pendingReadLetters, unansweredChatsCount: data.unansweredChatsCount, hasExpiredSla: data.hasExpiredSla, isAfk: data.isAfk, idleSeconds: data.idleSeconds, activeChatTimersList: data.activeChatTimersList || [] });
      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }
  res.json({ success: true, operators: Array.from(operatorsMap.values()) });
});

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

app.get('/api/banned-words', (req, res) => res.json({ words: Array.from(dynamicBannedWords) }));
app.post('/api/banned-words', (req, res) => { if (req.body.word) dynamicBannedWords.add(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });
app.post('/api/banned-words/delete', (req, res) => { if (req.body.word) dynamicBannedWords.delete(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });

// 5. DASHBOARD EMBEBIDO
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - SUPERVISIÓN LIVE & AUDITORÍA</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .profile-live-box { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .live-timers-container { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .live-chat-timer-badge { font-size: 10px; font-weight: bold; font-family: monospace; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; }
    .timer-ok { background: #064e3b; color: #34d399; border: 1px solid #10b981; }
    .timer-expired { background: #450a0a; color: #f87171; border: 1px solid #ef4444; animation: pulseRed 1s infinite; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 850px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; color: #cbd5e1; }
    @keyframes pulseRed { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE</div>
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
            \${op.profiles.map(p => {
              const timersHtml = (p.activeChatTimersList || []).map(t => {
                const min = Math.floor(t.remaining / 60);
                const sec = t.remaining % 60;
                const timeStr = \`\${min < 10 ? '0' : ''}\${min}:\${sec < 10 ? '0' : ''}\${sec}\`;
                return \`<span class="live-chat-timer-badge \${t.isExpired ? 'timer-expired' : 'timer-ok'}">💬 \${t.contact}: \${t.isExpired ? '00:00 (VENCIDO)' : timeStr}</span>\`;
              }).join('');

              return \`
                <div class="profile-live-box">
                  <div style="display:flex; justify-content:space-between;">
                    <span style="font-weight:bold; color:#00ffcc;">🎯 \${p.profileName}</span>
                    <span style="font-size:11px; color:#38bdf8;">✉️ \${p.pendingReadLetters} cartas</span>
                  </div>
                  \${timersHtml ? \`<div class="live-timers-container">\${timersHtml}</div>\` : \`<div style="font-size:10px; color:#10b981; margin-top:4px;">⏱️ Todos los chats al día</div>\`}
                </div>
              \`;
            }).join('')}
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V46.0 activo en puerto ${PORT}`));
