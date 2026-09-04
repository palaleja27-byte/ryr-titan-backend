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

// CANAL DE MENSAJES SUPERVISOR ↔ OPERADOR
const supervisorOperatorChatsMap = new Map(); // operatorKey -> Array of messages

let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. ENDPOINTS DEL CHAT SUPERVISOR ↔ OPERADOR
app.post('/api/chat/supervisor/send', (req, res) => {
  const { operatorName, text } = req.body;
  if (!operatorName || !text) return res.status(400).json({ error: 'Datos incompletos' });

  const opKey = operatorName.toLowerCase().trim();
  if (!supervisorOperatorChatsMap.has(opKey)) {
    supervisorOperatorChatsMap.set(opKey, []);
  }

  const msgObj = {
    id: `msg_${Date.now()}`,
    sender: 'SUPERVISOR',
    text: text.trim(),
    timestamp: Date.now(),
    delivered: false
  };

  supervisorOperatorChatsMap.get(opKey).push(msgObj);
  res.json({ success: true, message: msgObj });
});

app.post('/api/chat/operator/send', (req, res) => {
  const { operatorName, text } = req.body;
  if (!operatorName || !text) return res.status(400).json({ error: 'Datos incompletos' });

  const opKey = operatorName.toLowerCase().trim();
  if (!supervisorOperatorChatsMap.has(opKey)) {
    supervisorOperatorChatsMap.set(opKey, []);
  }

  const msgObj = {
    id: `msg_${Date.now()}`,
    sender: 'OPERATOR',
    text: text.trim(),
    timestamp: Date.now()
  };

  supervisorOperatorChatsMap.get(opKey).push(msgObj);
  res.json({ success: true, message: msgObj });
});

app.get('/api/chat/messages/:operatorName', (req, res) => {
  const opKey = req.params.operatorName.toLowerCase().trim();
  const msgs = supervisorOperatorChatsMap.get(opKey) || [];
  res.json({ success: true, messages: msgs });
});

// 2. RESOLUTOR DE MODELOS DE GROQ
let cachedGroqModel = null;
async function getAvailableGroqModel(apiKey) {
  if (cachedGroqModel) return cachedGroqModel;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'RYR-Titan-Apex/1.0' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.data)) {
        const ids = data.data.map(m => m.id);
        const prefs = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama3-70b-8192', 'llama-3.1-8b-instant', 'llama3-8b-8192'];
        for (let p of prefs) {
          if (ids.includes(p)) {
            cachedGroqModel = p;
            return cachedGroqModel;
          }
        }
        if (ids.length > 0) return ids[0];
      }
    }
  } catch (e) {}
  return 'llama-3.3-70b-versatile';
}

// 3. MOTOR DE IA
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName, bioData) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'la clienta';
  const safeProfile = profileName || 'HORACIO';

  const systemPrompt = `Eres el Co-Piloto de IA, Psicólogo y Estratega de Citas de la agencia RYR TITAN operando en Talkytimes.
Analizas el historial real de conversación entre la clienta (${safeClient}) y el perfil asignado (${safeProfile}).

DATOS DE PERFIL DE ${safeClient}:
- Ubicación: ${bioData?.country || 'No especificado'}
- Edad / Nacimiento: ${bioData?.birthDate || 'No especificado'}
- Estado Civil: ${bioData?.maritalStatus || 'Not married / Soltera'}

REGLAS DE ORO:
1. RESPONDE CON RAZONAMIENTO REAL a cualquier pregunta del operador (hijos, mascotas, trabajo, créditos, estado de ánimo, qué busca, etc.).
2. Si te piden un mensaje de conquista, ataque o respuesta, redacta una opción en inglés (para copiar) y su traducción en español.
3. CERO TRAVEL MISLEADING (TM): NUNCA insinúes encuentros físicos, citas en persona ni viajes.
4. PROHIBIDO mostrar textos de proceso como "Here is a thinking process" o asteriscos dobles (**). Devuelve únicamente la respuesta final limpia en español.`;

  if (GROQ_API_KEY && GROQ_API_KEY.startsWith('gsk_')) {
    const targetModel = await getAvailableGroqModel(GROQ_API_KEY);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'RYR-Titan-Apex/1.0'
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `HISTORIAL DEL CHAT:\n${fullTranscript || 'Sin historial previo.'}\n\nCONSULTA DEL OPERADOR:\n${prompt}` }
          ],
          temperature: 0.65,
          max_tokens: 850
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message?.content) {
          let answer = data.choices[0].message.content.replace(/\*\*/g, '').trim();
          answer = answer.replace(/Here'?s a thinking process[\s\S]*?(?=\n\n|\n[A-Z]|$)/i, '').trim();
          answer = answer.replace(/^<think>[\s\S]*?<\/think>/i, '').trim();
          return answer;
        }
      }
    } catch (err) {}
  }

  const pLower = (prompt || '').toLowerCase();
  if (/(ataque|conquista|mensaje|responder)/i.test(pLower)) {
    return `🎯 Mensaje para ${safeClient}:
Conviene conectar con su lado sensible y hacerle una pregunta abierta.

💬 Opción en Inglés:
"I was just sitting here smiling, thinking about our conversation. There's something genuinely refreshing about you. How has your day been?"
(Traducción: "Estaba aquí sentado sonriendo, pensando en nuestra conversación. ¿Cómo ha estado tu día?")`;
  }

  return `📋 Análisis sobre ${safeClient}:
Ubicación: ${bioData?.country || 'En perfil'}. Historial revisado. Puedes pedirme mensajes de ataque o consultar cualquier duda sobre su vida.`;
}

// 4. ENDPOINTS DE INTELIGENCIA
app.post('/api/intelligence/query', async (req, res) => {
  try {
    const { query, clientId, clientName, profileName, bioData, liveMarkdown } = req.body;
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

    const aiAnswer = await generateMasterAiResponse(query, chatMd, clientName, profileName, bioData);
    res.json({ success: true, answer: aiAnswer });
  } catch (err) {
    res.json({ success: true, answer: `Consulta procesada con éxito.` });
  }
});

app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName || 'Cliente';

  if (SUPABASE_URL && SUPABASE_KEY && clientId !== 'N/A') {
    try {
      let resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&select=*&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      let data = await resp.json();

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
      location: /(brazil|brasil)/i.test(textLower) ? 'Brazil' : (/(united states|eeuu)/i.test(textLower) ? 'United States' : 'En perfil'),
      birthDate: 'En perfil',
      maritalStatus: 'Not married',
      pets: 'No especificado aún',
      family: 'No especificado aún',
      work: 'Activo laboralmente',
      summary: `Expediente de ${clientName} verificado en Supabase.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

// 5. MOTOR HEURÍSTICO DE PATRONES (ANTI-TM)
function runDeepAiPatternAnalysis(operator, profile, clientName, clientId, markdown) {
  const textLower = (markdown || '').toLowerCase();
  const findings = [];
  let qualityScore = 100;
  let riskLevel = 'BAJO';

  const tmRegex = /(?:when we meet|when i visit|come visit|meet in person|see you in person|book a flight|buy a ticket|flying to you|fly to you|stay at a hotel|pack your bags|plane ticket|flight ticket|live together soon|cuando nos veamos|cuando nos conozcamos en persona|cuando viaje|ven a verme|viajar a verte|comprar el pasaje|boleto de avión|hotel juntos|nos vemos en persona)/i;
  if (tmRegex.test(textLower)) {
    findings.push({
      type: 'CRITICAL',
      title: '🚨 INFRACCIÓN: TRAVEL MISLEADING (TM)',
      description: 'Insinuación de encuentro personal o viaje físico detectada en el diálogo.'
    });
    qualityScore -= 45;
    riskLevel = 'CRÍTICO';
  }

  if (/(?:si me quisieras|si me amaras|envíame un regalo|mandame un regalo|dame un regalo|cómprame un regalo|send me a gift|need coins)/i.test(textLower)) {
    findings.push({
      type: 'CRITICAL',
      title: '🛑 Coacción por Regalos',
      description: 'Petición directa de regalos condicionando el afecto.'
    });
    qualityScore -= 30;
    if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
  }

  if (/(?:cállate|callate|no me importa|qué pereza|que pereza|apúrate|apurate|no tengo tiempo|fastidio|idiota|shut up|waste of time)/i.test(textLower)) {
    findings.push({
      type: 'CRITICAL',
      title: '🚨 Maltrato / Tono Hostil',
      description: 'Lenguaje inapropiado o agresivo detectado.'
    });
    qualityScore -= 30;
    riskLevel = 'CRÍTICO';
  }

  qualityScore = Math.max(0, qualityScore);

  return {
    score: qualityScore,
    riskLevel: riskLevel,
    diagnosis: riskLevel === 'CRÍTICO' ? 'ALTO RIESGO: Infracciones detectadas.' : 'Conversación fluida y respetuosa.',
    recommendation: riskLevel === 'CRÍTICO' ? 'Corregir al operador sobre Travel Misleading.' : 'Mantener el ritmo de conversación.',
    findings: findings
  };
}

// 6. AUDITORÍA Y GUARDADO
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String((clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Cliente').trim();
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

// 7. GESTIÓN DE ALERTAS Y MULTAS
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
    amount: 10000,
    reason: reason || 'SLA 2 Minutos Excedido',
    created_at: new Date().toISOString()
  };

  operatorFinesRAM.set(fineId, finePayload);

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/operator_fines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify(finePayload)
    }).catch(() => {});
  }

  res.json({ success: true, fine: finePayload });
});

app.get('/api/fines', async (req, res) => {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/operator_fines?select=*&order=created_at.desc&limit=100`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) return res.json({ success: true, fines: data });
    } catch (e) {}
  }
  res.json({ success: true, fines: Array.from(operatorFinesRAM.values()).reverse() });
});

// 8. TELEMETRÍA (ENTREGA MENSAJES DEL SUPERVISOR AL OPERADOR)
app.post('/api/telemetry', (req, res) => {
  const {
    operator, shift, profile, profileId,
    pendingReadLetters, unansweredChatsCount,
    hasExpiredSla, isAfk, idleSeconds, activeChatTimersList,
    prospectingProgress, status
  } = req.body;

  if (!operator || !profile) return res.status(400).json({ error: 'Faltan datos' });

  const opKey = operator.toLowerCase().trim();
  const sessionKey = `${opKey}_${profile.toLowerCase().trim()}`;
  
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
    prospectingProgress: prospectingProgress || null,
    lastSeen: Date.now()
  });

  // Extraer mensajes no leídos del supervisor para este operador
  const chatMessages = supervisorOperatorChatsMap.get(opKey) || [];
  const unreadSupervisorMsgs = chatMessages.filter(m => m.sender === 'SUPERVISOR' && !m.delivered);
  unreadSupervisorMsgs.forEach(m => m.delivered = true);

  res.json({ success: true, supervisorMessages: unreadSupervisorMsgs });
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
      opEntry.profiles.push({
        profileName: data.profileName,
        profileId: data.profi
