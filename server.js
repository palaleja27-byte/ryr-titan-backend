const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Sanitización de variables de entorno
function cleanEnv(val) {
  return String(val || '').replace(/['"\r\n\s]/g, '').trim();
}

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, '');
const SUPABASE_KEY = cleanEnv(process.env.SUPABASE_KEY);
const GROQ_API_KEY = cleanEnv(process.env.GROQ_API_KEY);
const OPENAI_API_KEY = cleanEnv(process.env.OPENAI_API_KEY);

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();
const activeAlertsMap = new Map();
const operatorFinesRAM = new Map();
const syncedClientsRegistry = new Set();

// 1. MOTOR DE IA CONVERSACIONAL (GROQ LLAMA 3.3 & 3.1)
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena, 56';
  const safeProfile = profileName || 'HORACIO';

  const systemPrompt = `Eres el Co-Piloto de IA y Estratega de Citas de la agencia RYR TITAN. 
Analizas el historial real de conversación entre el cliente (${safeClient}) y el perfil (${safeProfile}).

REGLAS DE ORO:
1. RAZONAMIENTO REAL: Responde con inteligencia humana a cualquier pregunta. Si preguntan por datos (hijos, mascotas, créditos, trabajo), búscalos en el chat y responde el hecho concreto.
2. CERO PLANTILLAS: No uses frases genéricas. Cada respuesta debe ser única y basada en lo que el cliente escribió.
3. CERO TRAVEL MISLEADING (TM): NUNCA prometas encuentros físicos o viajes. Desvía hacia la conexión emocional.
4. FORMATO: 
   - Si es análisis: Texto directo en español.
   - Si es respuesta: Explicación táctica + Opción en Inglés (copiable) + Traducción.
5. Texto limpio sin asteriscos.`;

  // MODELOS OFICIALES GROQ ACTUALIZADOS
  const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];

  if (GROQ_API_KEY && GROQ_API_KEY.includes('gsk_')) {
    for (let model of groqModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `HISTORIAL:\n${fullTranscript}\n\nPREGUNTA:\n${prompt}` }
            ],
            temperature: 0.7
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          return data.choices[0].message.content.replace(/\*\*/g, '').trim();
        }
      } catch (err) {
        console.error(`Fallo en modelo ${model}, intentando siguiente...`);
      }
    }
  }

  // FALLBACK SI TODO FALLA
  return `📋 Análisis para ${safeClient}:\nEl sistema de IA está procesando los datos. Por favor, asegúrate de haber sincronizado el chat con el botón ⚡.`;
}

// 2. ENDPOINTS
app.post('/api/intelligence/query', async (req, res) => {
  const { query, clientId, clientName, profileName, liveMarkdown } = req.body;
  const targetId = String(clientId || '').trim();
  let chatMd = liveMarkdown || '';

  if (!chatMd && SUPABASE_URL && SUPABASE_KEY && targetId !== 'N/A') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${targetId}&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (data[0]) chatMd = data[0].markdown;
    } catch (e) {}
  }

  const answer = await generateMasterAiResponse(query, chatMd, clientName, profileName);
  res.json({ answer });
});

app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = req.params.clientId;
  let chatMd = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?client_id=eq.${clientId}&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (data[0]) chatMd = data[0].markdown;
    } catch (e) {}
  }
  if (chatMd) {
    res.json({ success: true, hasData: true, dossier: { clientName: 'Usuario', maritalStatus: 'Consultar Chat', summary: 'Historial cargado.' } });
  } else {
    res.json({ success: false, hasData: false });
  }
});

app.get('/api/chats/synced-ids', async (req, res) => {
  const profile = req.query.profile;
  const syncedSet = new Set();
  if (SUPABASE_URL && SUPABASE_KEY && profile) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?profile_name=eq.${profile}&select=client_id`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) data.forEach(d => syncedSet.add(String(d.client_id)));
    } catch (e) {}
  }
  res.json({ syncedIds: Array.from(syncedSet) });
});

app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown } = req.body;
  const auditPayload = { id: `${profile}_${clientId}`, operator_name: operator, profile_name: profile, client_name: clientName, client_id: clientId, markdown, updated_at: new Date().toISOString() };
  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    });
  }
  res.json({ success: true });
});

app.post('/api/telemetry', (req, res) => {
  const data = req.body;
  const sessionKey = `${data.operator}_${data.profile}`.toLowerCase();
  liveTelemetryMap.set(sessionKey, { ...data, lastSeen: Date.now() });
  res.json({ success: true });
});

app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operators = [];
  for (const [key, data] of liveTelemetryMap.entries()) {
    if (now - data.lastSeen < 35000) operators.push(data);
  }
  res.json({ success: true, operators });
});

app.get('/api/banned-words', (req, res) => res.json({ words: ['whatsapp', 'skype', 'email', 'teléfono', 'instagram', 'telegram', 'prometo'] }));

app.get('/monitor.html', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>RYR TITAN MONITOR</title><style>body{background:#060913;color:#fff;font-family:sans-serif;padding:20px;}</style></head><body><header><h1>⚡ MONITOR LIVE</h1></header><div id="grid"></div><script>setInterval(async()=>{ const r=await fetch('/api/telemetry/live'); const d=await r.json(); document.getElementById('grid').innerHTML = JSON.stringify(d.operators); },2000);</script></body></html>`);
});

app.listen(PORT, () => console.log(`🚀 Server activo en puerto ${PORT}`));
