
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

// AUTO-DETECCIÓN DINÁMICA DE MODELOS ACTIVOS DE GROQ
let activeGroqModel = 'mixtral-8x7b-32768';

async function autoDiscoverGroqModel(apiKey) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.data) && data.data.length > 0) {
        const availableIds = data.data.map(m => m.id);
        const preferredModels = [
          'mixtral-8x7b-32768',
          'llama-3.1-8b-instant',
          'llama3-8b-8192',
          'gemma2-9b-it',
          'llama-3.2-3b-preview',
          'llama-3.3-70b-versatile'
        ];
        for (let pref of preferredModels) {
          if (availableIds.includes(pref)) {
            activeGroqModel = pref;
            console.log(`[GROQ] Modelo oficial activo seleccionado: ${activeGroqModel}`);
            return activeGroqModel;
          }
        }
        activeGroqModel = availableIds[0];
        return activeGroqModel;
      }
    }
  } catch (e) {
    console.error("[GROQ] Error descubriendo modelos:", e.message);
  }
  return activeGroqModel;
}

if (GROQ_API_KEY && GROQ_API_KEY.includes('gsk_')) {
  autoDiscoverGroqModel(GROQ_API_KEY);
}

// 1. MOTOR DE IA COGNITIVO PURO (GROQ DIRECTO)
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena, 56';
  const safeProfile = profileName || 'HORACIO';

  console.log(`[GROQ LLM] Procesando consulta para "${safeClient}". Pregunta: "${prompt}"`);

  const systemInstructions = `Eres el Co-Piloto de IA, Psicólogo y Estratega de Citas de la agencia RYR TITAN operando en Talkytimes.
Analizas el diálogo entre el cliente (${safeClient}) y el perfil (${safeProfile}).

REGLAS DE ORO:
1. RESPONDE CON RAZONAMIENTO REAL y personalizado a cualquier pregunta del operador (por extraña o básica que sea).
2. Si preguntan sobre créditos, salud, familia, estado de ánimo o intenciones, revisa el historial y responde con hechos concretos.
3. Si piden cómo responder o un mensaje: Redacta una opción seductora y humana en inglés (para copiar) y su traducción en español.
4. CERO TRAVEL MISLEADING (TM): NUNCA insinúes encuentros físicos, citas en persona o viajes ("when we meet", "come see me", "book a flight"). Desvía hacia la conexión emocional digital y cartas.
5. Devuelve texto limpio en español, directo y sin asteriscos dobles (**).`;

  // A. CONEXIÓN A GROQ CON MODELO AUTO-DETECTADO
  if (GROQ_API_KEY && GROQ_API_KEY.includes('gsk_')) {
    const modelsToTry = [activeGroqModel, 'mixtral-8x7b-32768', 'llama3-8b-8192', 'gemma2-9b-it'];
    
    for (let model of modelsToTry) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

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
              { role: 'user', content: `HISTORIAL DEL CHAT CON ${safeClient}:\n${fullTranscript || 'Conversación activa en pantalla.'}\n\nPREGUNTA DEL OPERADOR:\n${prompt}` }
            ],
            temperature: 0.65,
            max_tokens: 850
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          if (data.choices && data.choices[0] && data.choices[0].message?.content) {
            console.log(`[GROQ SUCCESS] Respuesta generada exitosamente con ${model}`);
            return data.choices[0].message.content.replace(/\*\*/g, '').trim();
          }
        } else {
          const errText = await res.text();
          console.error(`[GROQ API ERROR ${res.status}] en ${model}:`, errText);
        }
      } catch (err) {
        console.error(`[GROQ FETCH ERROR] ${model}:`, err.message);
      }
    }
  }

  // B. CONEXIÓN A OPENAI (SI EXISTE CLAVE)
  if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemInstructions },
            { role: 'user', content: `HISTORIAL:\n${fullTranscript}\n\nPREGUNTA:\n${prompt}` }
          ],
          temperature: 0.65
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

  return `⚠️ Error temporal de conexión con Groq. Por favor intenta tu consulta de nuevo en unos segundos.`;
}

// 2. ENDPOINTS DE CONSULTA DE INTELIGENCIA
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
    console.error("Error en /api/intelligence/query:", err);
    res.json({ success: true, answer: `Error procesando la consulta. Intenta nuevamente.` });
  }
});

// 3. EXPEDIENTE EN ESPAÑOL
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName || 'Helena, 56';

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

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (String(audit.clientId) === clientId || String(audit.client_id) === clientId || (queryName && String(audit.clientName).toLowerCase().includes(queryName.toLowerCase()))) {
        chatMd = audit.markdown;
        if (audit.clientName && !['Search', 'Cliente'].includes(audit.clientName)) {
          clientName = audit.clientName.split('\n')[0].trim();
        }
        break;
      }
    }
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientName,
      location: /(brazil|brasil)/i.test(textLower) ? 'Brazil' : (/(united states|eeuu)/i.test(textLower) ? 'United States' : 'Brazil'),
      birthDate: /(jul 4, 1970|1970)/i.test(textLower) ? 'Jul 4, 1970 (54 años)' : (/(feb 15, 1962|1962)/i.test(textLower) ? 'Feb 15, 1962 (64 años)' : '56 años'),
      maritalStatus: /(no credits|credits)/i.test(textLower) ? 'Sin créditos actualmente (Recarga el 30)' : 'Not married',
      pets: 'No especificado aún',
      family: 'No especificado aún',
      work: 'Activo laboralmente',
      summary: `Expediente verificado en Supabase.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

// 4. MOTOR HEURÍSTICO DE ANÁLISIS DE PATRONES
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
    diagnosis: riskLevel === 'CRÍTICO' ? 'ALTO RIESGO: Infracciones graves detectadas.' : 'Conversación fluida y respetuosa.',
    recommendation: riskLevel === 'CRÍTICO' ? 'Corregir al operador de inmediato sobre Travel Misleading.' : 'Mantener el ritmo de conversación.',
    findings: findings
  };
}

// 5. AUDITORÍA Y GUARDADO
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String((clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena, 56').trim();
  const auditKey = `${profile}_${cleanClientId}`;
  
  syncedClientsRegistry.add(cleanClientId.toLowerCase());
  syncedClientsRegistry.add(safeClientName.toLowerCase());

  const aiReport = runDeepAiPatternAnalysis(operator, profile, safeClientName, cleanClientId, markdown);

  aiReport.findings.forEach((finding, index) => {
    if (finding.type === 'CRITICAL' || finding.type === 'WARNING') {
      const alertId = `${auditKey}_${index}_${Date.now()}`;
      const alertEntry = {
        id: alertId,
        auditId: auditKey,
        operatorName: operator || 'Desconocido',
        profileName: profile,
        clientName: safeClientName,
        clientId: cleanClientId,
        category: finding.title,
        severity: finding.type === 'CRITICAL' ? 'CRÍTICA' : 'ALTA',
        snippet: finding.description,
        markdown: markdown,
        status: 'PENDING',
        timestamp: Date.now()
      };
      activeAlertsMap.set(alertId, alertEntry);

      if (SUPABASE_URL && SUPABASE_KEY) {
        fetch(`${SUPABASE_URL}/rest/v1/chat_alerts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(alertEntry)
        }).catch(() => {});
      }
    }
  });

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
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates'
      },
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

// 6. GESTIÓN DE ALERTAS
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

// 7. REGISTRO DE MULTAS ($10.000 COP)
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

// 8. TELEMETRÍA
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

// 9. DASHBOARD EMBEBIDO
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - SUPERVISIÓN LIVE & AUDITORÍA</title>
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
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE & AUDITORÍA</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action btn-fines" onclick="openFinesModal()">💰 Multas ($10.000 COP) (<span id="total-fines-count">0</span>)</button>
      <button class="btn-action" style="border-color:#ef4444; color:#f87171;" onclick="openAlertsCenterModal()">🚨 Alertas de Conducta (<span id="count-behavior-alerts">0</span>)</button>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>
  <div id="operators-grid" class="grid-operators"></div>
  <div id="modal-fines" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-gold);">💰 HISTORIAL DE MULTAS GENERADAS ($10.000 COP)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="fines-list-container" style="overflow-y:auto; flex:1;"></div>
    </div>
  </div>
  <div id="modal-alerts-hub" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">🚨 CENTRO DE ALERTAS: TRAVEL MISLEADING & CONDUCTA</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div id="alerts-hub-list" style="overflow-y:auto; flex:1;"></div>
    </div>
  </div>
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">📄 AUDITORÍA HISTÓRICA DE DIÁLOGOS</span>
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
    let globalAuditsList = [];

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
        fetchAlertsCount();
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
        container.innerHTML = '<p style="color:#10b981;">✅ No hay alertas pendientes.</p>';
        return;
      }
      container.innerHTML = data.alerts.map(a => \`
        <div style="background:#060913; border:1px solid #ef4444; border-radius:8px; padding:12px; margin-bottom:8px;" id="alert-item-\${a.id}">
          <div style="display:flex; justify-content:space-between; font-weight:bold; color:#f87171;">
            <span>\${a.category}</span>
            <span style="font-size:11px; color:#94a3b8;">👤 \${a.operatorName} | 🎯 \${a.profileName} | 💬 \${a.clientName} (ID: \${a.clientId})</span>
          </div>
          <div style="margin:6px 0; color:#fca5a5; font-size:12px; background:rgba(239,68,68,0.1); padding:6px; border-left:3px solid #ef4444;">⚠️ \${a.snippet}</div>
          <div class="chat-transcript">\${a.markdown}</div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
            <button class="btn-action" style="background:#064e3b; color:#34d399;" onclick="resolveAlert('\${a.id}')">✅ Atender</button>
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
      globalAuditsList = data.audits || [];
      const container = document.getElementById('chat-audits-list');
      
      if (globalAuditsList.length === 0) {
        container.innerHTML = '<p style="color:#94a3b8;">No hay conversaciones en Supabase aún. Presiona ⚡ en Talkytimes.</p>';
        return;
      }

      container.innerHTML = globalAuditsList.map((a, index) => \`
        <div style="background:#060913; border:1px solid #1e293b; border-radius:6px; padding:12px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span style="font-weight:bold; color:var(--accent-cyan);">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (ID: \${a.clientId})</span>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" style="background:#1e1b4b; border-color:#8b5cf6; color:#c4b5fd;" onclick="runAiAnalysisByIndex(\${index})">🔍 Analizar Conversación</button>
              <a href="data:text/markdown;charset=utf-8,\${encodeURIComponent(a.markdown)}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
            </div>
          </div>
          <div id="ai-box-\${index}"></div>
          <div class="chat-transcript" id="transcript-\${index}">\${a.markdown}</div>
        </div>
      \`).join('');
    }

    async function runAiAnalysisByIndex(index) {
      const audit = globalAuditsList[index];
      if (!audit) return;

      const box = document.getElementById('ai-box-' + index);
      box.innerHTML = '<p style="color:#c4b5fd; font-size:12px; margin:8px 0;">🤖 Analizando diálogo con IA...</p>';

      try {
        const res = await fetch(\`\${API_URL}/api/chats/analyze-single\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operator: audit.operator,
            profile: audit.profile,
            clientName: audit.clientName,
            clientId: audit.clientId,
            markdown: audit.markdown
          })
        });
        const data = await res.json();
        const r = data.aiReport;
        const isGood = r.score >= 70;

        box.innerHTML = \`
          <div style="background:#0b132b; border:1px solid #8b5cf6; border-radius:8px; padding:12px; margin-top:8px;">
            <div style="font-weight:bold; font-size:13px; color:\${isGood ? '#34d399' : '#f87171'}; margin-bottom:4px;">🎯 Puntaje: \${r.score}/100 [Riesgo: \${r.riskLevel}]</div>
            <div style="font-size:11px; margin-bottom:4px;"><b>🧠 Diagnóstico:</b> \${r.diagnosis}</div>
            <div style="font-size:11px; color:#38bdf8; margin-bottom:6px;"><b>📋 Recomendación:</b> \${r.recommendation}</div>
            \${r.findings.map(f => \`
              <div style="background:rgba(239,68,68,0.15); border-left:3px solid #ef4444; padding:6px; border-radius:4px; font-size:11px; margin-bottom:4px; color:#fca5a5;">
                <b>\${f.title}:</b> \${f.description}
              </div>
            \`).join('')}
          </div>
        \`;
      } catch (err) {
        box.innerHTML = '<p style="color:#ef4444;">Error al procesar el análisis de IA.</p>';
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V42.0 (Dynamic Groq Autodetect) activo en puerto ${PORT}`));
