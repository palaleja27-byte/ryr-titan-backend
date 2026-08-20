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

// 1. MOTOR DE IA MODO /human CON CUMPLIMIENTO ESTRICTO ANTI-TRAVEL MISLEADING (ANTI-TM)
async function generateSafeHumanizedMessages(prompt, fullTranscript, clientName, profileName) {
  const safeClient = (clientName && clientName !== 'Search' && clientName !== 'Cliente') ? clientName.split('\n')[0].trim() : 'Jaye, 64';
  const safeProfile = profileName || 'HORACIO';

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
              content: `Eres el Asistente de IA y Estratega de Chat para la agencia RYR TITAN. Operas en modo /human (alta empatía, romanticismo cálido y natural).
              
              REGLA DE ORO DE SEGURIDAD (POLÍTICA ESTRICTA DE LA PLATAFORMA - CERO TRAVEL MISLEADING):
              - PROHIBICIÓN ABSOLUTA de insinuar encuentros en persona, citas físicas, viajes, visitas o promesas de vivir juntos en el mundo real (NUNCA digas: "when we meet", "when I visit", "come see me", "book a flight", "travel to you").
              - Si el cliente insiste en verse en persona o vivir juntos, debes DESVIAR la conversación con elegancia hacia el presente: enfocarse en la conexión emocional que tienen aquí, conocerse a fondo por cartas y valorar este espacio digital íntimo.
              - Estructura de respuesta limpia:
                1. Breve explicación táctica (1-2 oraciones).
                2. Opción en Inglés (lista para copiar y enviar).
                3. Traducción al Español.`
            },
            { role: 'user', content: `CLIENTE: ${safeClient}\nHISTORIAL:\n${fullTranscript}\n\nPETICIÓN:\n${prompt}` }
          ],
          temperature: 0.65
        })
      });
      const data = await response.json();
      if (data.choices && data.choices[0]) {
        return data.choices[0].message.content.replace(/\*\*/g, '');
      }
    } catch (e) {}
  }

  // MOTOR NATIVO CON PROTOCOLO ANTI-TM (Costo $0)
  const pLower = (prompt || '').toLowerCase();
  let cleanResponse = '';

  if (/(llamar la atencion|llamar la atención|gancho|mensaje para|atraer|reconectar)/i.test(pLower)) {
    cleanResponse = `💡 Estrategia Segura (Cero Travel Misleading):
Desviamos la presión de un encuentro físico hacia una conexión emocional profunda en el presente, haciéndola sentir escuchada y especial sin violar las normas de la plataforma.

💬 Opción en Inglés (Copiar y Enviar):
"I've been reflecting on what you said, and I truly value how open and honest you are with me. What matters most to me right now is understanding your heart, your thoughts, and building something genuinely meaningful between us. What is something about you that very few people truly know?"

💬 Traducción al Español:
"He estado reflexionando sobre lo que dijiste, y realmente valoro lo abierta y honesta que eres conmigo. Lo que más me importa ahora es comprender tu corazón, tus pensamientos y construir algo genuinamente significativo entre nosotros. ¿Qué es algo de ti que muy pocas personas realmente conocen?"`;
  } else if (/(carta|letter|invitar|vender)/i.test(pLower)) {
    cleanResponse = `💡 Estrategia Segura para Carta (Monetización Permitida):
Invitamos al cliente a profundizar a través de una carta detallada sin prometer encuentros físicos.

💬 Opción en Inglés (Copiar y Enviar):
"You have such a special way of expressing yourself. I wanted to share some deeper reflections about my life and what our connection means to me, so I wrote a long letter for you. I hope it brings a warm smile to your day."

💬 Traducción al Español:
"Tienes una forma muy especial de expresarte. Quería compartir algunas reflexiones más profundas sobre mi vida y lo que significa nuestra conexión para mí, así que te escribí una carta larga. Espero que te saque una cálida sonrisa hoy."`;
  } else {
    cleanResponse = `💡 Respuesta Táctica Segura:
Enfocada en validar las emociones del cliente y mantener la interacción en el chat sin dar falsas expectativas de viajes.

💬 Opción en Inglés (Copiar y Enviar):
"I really appreciate your vulnerability with me. I want you to feel completely comfortable and safe sharing whatever is on your mind. Having you in my days brings me a lot of peace. How has your day been treating you so far?"

💬 Traducción al Español:
"Aprecio mucho tu vulnerabilidad conmigo. Quiero que te sientas completamente cómoda y segura compartiendo lo que tengas en mente. Tenerte en mis días me trae mucha paz. ¿Cómo te ha tratado el día hasta ahora?"`;
  }

  return cleanResponse;
}

// 2. MOTOR DE AUDITORÍA HEURÍSTICA CON DETECCIÓN DE TRAVEL MISLEADING (TM)
function runDeepAiPatternAnalysis(operator, profile, clientName, clientId, markdown) {
  const textLower = (markdown || '').toLowerCase();
  const findings = [];
  let qualityScore = 100;
  let riskLevel = 'BAJO';

  // A. DETECCIÓN CRÍTICA DE TRAVEL MISLEADING (TM) / PROMESAS DE VIAJE O ENCUENTRO
  const travelMisleadingRegex = /(?:when we meet|when i visit|come visit|meet in person|see you in person|book a flight|buy a ticket|flying to you|fly to you|stay at a hotel|pack your bags|live together soon|cuando nos veamos|cuando nos conozcamos en persona|cuando viaje|ven a verme|viajar a verte|comprar el pasaje|boleto de avión|hotel juntos|nos vemos pronto en persona)/i;
  if (travelMisleadingRegex.test(textLower)) {
    findings.push({
      title: '🚨 INFRACCIÓN GRAVE: TRAVEL MISLEADING (TM)',
      description: 'El operador insinuó un encuentro personal, cita física o viaje, violando la regla de oro de la agencia y poniendo la cuenta en riesgo de sanción.'
    });
    qualityScore -= 45;
    riskLevel = 'CRÍTICO';
  }

  // B. Coacción / Mendicidad de Regalos
  if (/(?:si me quisieras|si me amaras|envíame un regalo|mandame un regalo|dame un regalo|cómprame un regalo|send me a gift|buy me a present|need coins)/i.test(textLower)) {
    findings.push({ title: '🛑 Coacción por Regalos', description: 'Petición directa de regalos detectada en el diálogo.' });
    qualityScore -= 30;
    if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
  }

  // C. Incomodidad del Cliente
  if (/(?:por qué me hablas así|por que me tratas así|no te acuerdas de mí|olvidaste mi nombre|solo quieres mi dinero|you forgot my name|you are rude)/i.test(textLower)) {
    findings.push({ title: '💔 Incomodidad Manifiesta del Cliente', description: 'Reclamo explícito del usuario en el historial.' });
    qualityScore -= 25;
    if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
  }

  // D. Hostilidad
  if (/(?:cállate|callate|no me importa|qué pereza|que pereza|apúrate|apurate|no tengo tiempo|fastidio|idiota|shut up|waste of time)/i.test(textLower)) {
    findings.push({ title: '🚨 Maltrato / Tono Hostil', description: 'Lenguaje inapropiado o agresivo detectado.' });
    qualityScore -= 30;
    riskLevel = 'CRÍTICO';
  }

  // E. Palabras Prohibidas
  for (let word of dynamicBannedWords) {
    if (textLower.includes(word.toLowerCase())) {
      findings.push({ title: '🛑 Palabra Prohibida', description: `Se detectó la palabra: "${word}".` });
      qualityScore -= 25;
      if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
      break;
    }
  }

  qualityScore = Math.max(0, qualityScore);

  let diagnosis = 'Conversación fluida, respetuosa y 100% libre de Travel Misleading (TM).';
  let recommendation = 'Mantener la interacción dentro de los límites de la plataforma.';

  if (riskLevel === 'CRÍTICO') {
    diagnosis = 'ALTO RIESGO: Se detectaron infracciones graves de Travel Misleading o conducta.';
    recommendation = 'Corregir al operador de inmediato. Recordar que NUNCA se debe prometer verse en persona.';
  }

  return {
    score: qualityScore,
    riskLevel: riskLevel,
    diagnosis: diagnosis,
    recommendation: recommendation,
    findings: findings
  };
}

// 3. ENDPOINT: ASISTENTE DE IA
app.post('/api/intelligence/query', async (req, res) => {
  const { query, clientId, clientName, profileName, liveMarkdown } = req.body;
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
      if (String(audit.clientId) === targetId || String(audit.client_id) === targetId) {
        chatMd = audit.markdown;
        break;
      }
    }
  }

  const safeResponse = await generateSafeHumanizedMessages(query, chatMd, clientName, profileName);
  res.json({ answer: safeResponse });
});

// 4. ENDPOINTS DE TELEMETRÍA Y DEMÁS
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName ? queryName.split('\n')[0].trim() : 'Jaye, 64';

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?or=(client_id.eq.${clientId},client_name.ilike.%${encodeURIComponent(queryName)}%)&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
        if (data[0].client_name && !['Search', 'Cliente'].includes(data[0].client_name)) clientName = data[0].client_name.split('\n')[0].trim();
      }
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (String(audit.clientId) === clientId || String(audit.client_id) === clientId || (queryName && String(audit.clientName).toLowerCase().includes(queryName.toLowerCase()))) {
        chatMd = audit.markdown;
        if (audit.clientName && !['Search', 'Cliente'].includes(audit.clientName)) clientName = audit.clientName.split('\n')[0].trim();
        break;
      }
    }
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientName,
      location: /(united states|eeuu)/i.test(textLower) ? 'United States' : 'Ubicación en perfil',
      birthDate: /(feb 15, 1962|1962)/i.test(textLower) ? 'Feb 15, 1962 (64 años)' : 'Edad en perfil',
      maritalStatus: /(living together|marriage|boda|casar)/i.test(textLower) ? 'Interesada en formalizar (Atención: No prometer viajes)' : 'Divorced / Viuda',
      pets: /(perro|dog)/i.test(textLower) ? 'Tiene perro' : 'No especificado',
      family: /(hijos|kids|son|daughter)/i.test(textLower) ? 'Tiene hijos' : 'No especificado aún',
      work: /(retirado|retired)/i.test(textLower) ? 'Retirado / Jubilado' : 'Activo laboralmente',
      summary: `Expediente seguro de ${clientName}. Todas las sugerencias cumplen con la política Anti-TM.`
    };
    return res.json({ success: true, dossier });
  }

  res.json({ success: false, dossier: null });
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

app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String((clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Jaye, 64').trim();
  const auditKey = `${profile}_${cleanClientId}`;
  
  syncedClientsRegistry.add(cleanClientId.toLowerCase());
  syncedClientsRegistry.add(safeClientName.toLowerCase());

  const aiReport = runDeepAiPatternAnalysis(operator, profile, safeClientName, cleanClientId, markdown);

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: safeClientName,
    client_id: cleanClientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: aiReport.findings.map(f => f.title),
    has_breach: aiReport.riskLevel === 'CRÍTICO' || aiReport.riskLevel === 'ALTO',
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

  res.json({ success: true, clientId: cleanClientId, clientName: safeClientName, aiReport });
});

app.post('/api/chats/analyze-single', (req, res) => {
  const { operator, profile, clientName, clientId, markdown } = req.body;
  const aiReport = runDeepAiPatternAnalysis(operator, profile, clientName, clientId, markdown);
  res.json({ success: true, aiReport });
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

// DASHBOARD
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - LIVE SUPERVISION & ANTI-TM AI</title>
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
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE & ANTI-TRAVEL MISLEADING</div>
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V18.0 (Anti-TM Strict) activo en puerto ${PORT}`));
