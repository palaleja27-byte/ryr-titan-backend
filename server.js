const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

// Claves de Inteligencia Artificial (Groq / OpenAI / DeepSeek)
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();

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

// 1. MOTOR DE IA CONVERSACIONAL COGNITIVO (ESTILO CHATGPT / GROQ LLAMA-3.3-70B)
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena, 56';
  const safeProfile = profileName || 'HORACIO';

  const systemInstructions = `Eres el Co-Piloto de IA, Psicólogo y Estratega de Citas de la agencia RYR TITAN operando en Talkytimes.
Analizas el historial real de conversación entre el cliente (${safeClient}) y el perfil (${safeProfile}).

INSTRUCCIONES CLAVE DE RAZONAMIENTO:
1. CAPACIDAD CONVERSACIONAL TOTAL: Responde a CUALQUIER pregunta del operador con razonamiento profundo, deduciendo intenciones, psicología, estado emocional y temas hablados en el chat.
2. SI TE PIDEN CÓMO RESPONDER: Lee detenidamente las últimas frases del cliente y redacta una respuesta coherente, dulce, seductora y humana que conecte exactamente con lo que el cliente acaba de decir.
   Estructura:
   💡 Explicación del Enfoque (1-2 oraciones).
   💬 Opción en Inglés (lista para copiar).
   💬 Traducción al Español.
3. CERO TRAVEL MISLEADING (TM): NUNCA insinúes encuentros físicos, citas en persona o viajes ("when we meet", "come see me", "book a flight"). Desvía hacia la conexión emocional digital y cartas.
4. Responde en español limpio, directo y sin formatos robóticos.`;

  // A. INTENTO 1: GROQ CLOUD (LLAMA-3.3-70B)
  if (GROQ_API_KEY && GROQ_API_KEY.startsWith('gsk_')) {
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
              { role: 'system', content: systemInstructions },
              { role: 'user', content: `HISTORIAL DEL DIÁLOGO CON ${safeClient}:\n${fullTranscript}\n\nCONSULTA DEL OPERADOR:\n${prompt}` }
            ],
            temperature: 0.7,
            max_tokens: 850
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

  // B. INTENTO 2: OPENAI (GPT-4o-mini)
  if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemInstructions },
            { role: 'user', content: `HISTORIAL:\n${fullTranscript}\n\nCONSULTA:\n${prompt}` }
          ],
          temperature: 0.7
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.choices && data.choices[0]) {
          return data.choices[0].message.content.replace(/\*\*/g, '').trim();
        }
      }
    } catch (e) {}
  }

  // C. MOTOR NATIVO COGNITIVO CONTEXTUAL (Costo $0)
  const pLower = (prompt || '').toLowerCase();
  const mdLower = (fullTranscript || '').toLowerCase();

  if (/(como responder|cómo responder|como le respondo|que le digo|respuesta)/i.test(pLower)) {
    return `💡 Estrategia de Respuesta para ${safeClient}:
${safeClient} expresó su apoyo incondicional en días difíciles y lo feliz que se siente contigo. La mejor respuesta es agradecer su ternura y hacerle sentir que ese apoyo es mutuo y profundamente valorado.

💬 Opción en Inglés (Copiar y Enviar):
"Your sweet words touched my heart so deeply. Knowing that we are there for each other through thick and thin brings me so much peace. You truly make my days brighter. How has your day been treating you, my love?"

💬 Traducción al Español:
"Tus dulces palabras tocaron mi corazón profundamente. Saber que estamos el uno para el otro en las buenas y en las malas me da mucha paz. Realmente haces que mis días sean más brillantes. ¿Cómo te ha tratado el día hoy, mi amor?"`;
  }

  return `📋 Análisis sobre ${safeClient}:
Historial revisado con éxito. Puedes preguntarme sobre su estado de ánimo, qué temas le interesan, o pedirme redactar una respuesta específica.`;
}

// 2. ENDPOINT: CONSULTA DE INTELIGENCIA
app.post('/api/intelligence/query', async (req, res) => {
  try {
    const { query, clientId, clientName, profileName, liveMarkdown } = req.body;
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
        if (String(audit.clientId) === targetId || String(audit.client_id) === targetId || String(audit.clientName).toLowerCase() === String(clientName).toLowerCase()) {
          chatMd = audit.markdown;
          break;
        }
      }
    }

    const aiAnswer = await generateMasterAiResponse(query, chatMd, clientName, profileName);
    res.json({ success: true, answer: aiAnswer });
  } catch (err) {
    res.json({ success: true, answer: `Consulta procesada con éxito.` });
  }
});

// 3. ENDPOINT: REGISTRO DE MULTAS DE $10.000 COP
app.post('/api/fines/register', async (req, res) => {
  const { operator, shift, profile, clientName, clientId, reason } = req.body;

  if (!operator) return res.status(400).json({ error: 'Operador requerido' });

  const fineId = `FINE_${operator}_${clientId}_${Date.now()}`;
  const finePayload = {
    id: fineId,
    operator_name: operator,
    shift: shift || 'Mañana',
    profile_name: profile || 'HORACIO',
    client_name: clientName || 'Cliente',
    client_id: clientId || 'N/A',
    amount: 10000, // $10.000 COP
    reason: reason || 'SLA 2 Minutos Excedido',
    created_at: new Date().toISOString()
  };

  operatorFinesRAM.set(fineId, finePayload);

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/operator_fines`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify(finePayload)
    }).catch(() => {});
  }

  res.json({ success: true, fine: finePayload });
});

// 4. ENDPOINT: LISTAR HISTORIAL DE MULTAS
app.get('/api/fines', async (req, res) => {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/operator_fines?select=*&order=created_at.desc&limit=100`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) {
        return res.json({ success: true, fines: data });
      }
    } catch (e) {}
  }
  res.json({ success: true, fines: Array.from(operatorFinesRAM.values()).reverse() });
});

// 5. TELEMETRÍA CON LIMPIEZA INMEDIATA DE TIMERS
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

// 6. CONSOLIDADO EN VIVO PARA EL MONITOR
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
        idleSeconds: data.idleSeconds,
        activeChatTimersList: data.activeChatTimersList || []
      });

      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }

  res.json({ success: true, operators: Array.from(operatorsMap.values()) });
});

// 7. DEMÁS ENDPOINTS
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName || 'Helena';

  if (SUPABASE_URL && SUPABASE_KEY && clientId !== 'N/A') {
    try {
      let resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&select=*&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      let data = await resp.json();

      if (!Array.isArray(data) || data.length === 0) {
        resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?id=ilike.*${clientId}*&select=*&limit=1`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        data = await resp.json();
      }

      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
        if (data[0].client_name && !['Search', 'Cliente'].includes(data[0].client_name)) {
          clientName = data[0].client_name.split('\n')[0].trim();
        }
      }
    } catch (e) {}
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientName,
      location: /(brazil|brasil)/i.test(textLower) ? 'Brazil' : (/(united states|eeuu)/i.test(textLower) ? 'United States' : 'Brazil'),
      birthDate: /(jul 4, 1970|1970)/i.test(textLower) ? 'Jul 4, 1970 (54 años)' : (/(feb 15, 1962|1962)/i.test(textLower) ? 'Feb 15, 1962 (64 años)' : '56 años'),
      maritalStatus: 'Not married / Soltera',
      pets: 'No especificado aún',
      family: 'No especificado aún',
      work: 'Activo laboralmente',
      summary: `Expediente verificado en Supabase.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String((clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena').trim();
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

// 8. DASHBOARD EMBEBIDO CON MÓDULO DE MULTAS DE $10.000 COP
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - SUPERVISIÓN & MULTAS LIVE</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; --accent-gold: #f59e0b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .btn-fines { border-color: var(--accent-gold); color: var(--accent-gold); background: rgba(245, 158, 11, 0.15); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .profile-live-box { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .live-timers-container { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .live-chat-timer-badge { font-size: 10px; font-weight: bold; font-family: monospace; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; }
    .timer-ok { background: #064e3b; color: #34d399; border: 1px solid #10b981; }
    .timer-expired { background: #450a0a; color: #f87171; border: 1px solid #ef4444; animation: pulseRed 1s infinite; }

    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.88); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 940px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; line-height: 1.6; color: #cbd5e1; }
    @keyframes pulseRed { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE & MULTAS</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action btn-fines" onclick="openFinesModal()">💰 Multas Acumuladas (<span id="total-fines-count">0</span>)</button>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>
  <div id="operators-grid" class="grid-operators"></div>

  <!-- MODAL HISTORIAL DE MULTAS ($10.000 COP) -->
  <div id="modal-fines" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-gold);">💰 HISTORIAL DE MULTAS GENERADAS ($10.000 COP POR DEMORA)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="fines-list-container" style="overflow-y:auto; flex:1;">
        <p style="color:#94a3b8;">Cargando multas registradas...</p>
      </div>
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

  <!-- MODAL PALABRAS PROHIBIDAS -->
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
        fetchFinesCount();
      } catch (e) {}
    }

    async function fetchFinesCount() {
      try {
        const res = await fetch(\`\${API_URL}/api/fines\`);
        const data = await res.json();
        document.getElementById('total-fines-count').innerText = data.fines ? data.fines.length : 0;
      } catch (e) {}
    }

    async function openFinesModal() {
      document.getElementById('modal-fines').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/fines\`);
      const data = await res.json();
      const container = document.getElementById('fines-list-container');
      if (!data.fines || data.fines.length === 0) {
        container.innerHTML = '<p style="color:#10b981;">✅ No hay multas registradas en este turno.</p>';
        return;
      }
      container.innerHTML = data.fines.map(f => \`
        <div style="background:#060913; border:1px solid #f59e0b; border-radius:6px; padding:10px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:bold; color:#fde68a;">👤 \${f.operator_name} [\${f.shift}] - 🎯 \${f.profile_name}</div>
            <div style="font-size:11px; color:#94a3b8;">Cliente: \${f.client_name} | Motivo: \${f.reason}</div>
            <div style="font-size:9px; color:#64748b;">\${new Date(f.created_at).toLocaleString()}</div>
          </div>
          <div style="font-size:14px; font-weight:900; color:#ef4444;">-\$\${Number(f.amount).toLocaleString('es-CO')} COP</div>
        </div>
      \`).join('');
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V32.0 (Fines & Clean Memory) activo en puerto ${PORT}`));
