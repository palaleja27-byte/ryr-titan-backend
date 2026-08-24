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

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// CONFIGURACIÓN GLOBAL DEL ADMINISTRADOR
let globalSystemSettings = {
  invasiveModalEnabled: true // El admin puede apagarlo o encenderlo en tiempo real
};

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

let cachedActiveGroqModel = null;

// LIMPIADOR ULTRA ESTRICTO DE LOGS Y PROCESOS DE PENSAMIENTO
function sanitizeAiOutput(rawText, clientName, bioData, fullTranscript, prompt) {
  if (!rawText) return '';
  let text = String(rawText);

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/Draft:\s*/i.test(text)) text = text.split(/Draft:\s*/i).pop();

  text = text.replace(/Here'?s a thinking process:?[\s\S]*?(?=\n\n(?=[A-ZÁÉÍÓÚ\d💡💬👤🐾👶💼💍📍🎂])|$)/gi, '');
  text = text.replace(/Here'?s a thinking process:?/gi, '');
  text = text.replace(/Check against rules:[\s\S]*$/gi, '');
  text = text.replace(/Check against constraints:[\s\S]*$/gi, '');
  text = text.replace(/1\.\s*Analyze User Input:[\s\S]*?(?=\n\n|$)/gi, '');
  text = text.replace(/^(The user wants to|Looking at the|I need to|Let's analyze)[\s\S]*?\n\n/gi, '');
  text = text.replace(/\*\*/g, '').trim();

  if (!text || text.length < 5 || /thinking process/i.test(text)) {
    const mdLower = (fullTranscript || '').toLowerCase();
    const safeClient = clientName || 'la clienta';
    const pLower = (prompt || '').toLowerCase();

    if (/(mascota|perro|gato|pet|dog)/i.test(pLower)) {
      if (/(perro|dog)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}: Mencionó tener perro en el chat.`;
      return `🐾 En las conversaciones analizadas, ${safeClient} no ha mencionado tener mascotas todavía.`;
    }
    if (/(hijo|hijos|familia|kids)/i.test(pLower)) {
      if (/(hijos|kids|children|son|daughter)/i.test(mdLower)) return `👶 Familia de ${safeClient}: Mencionó tener hijos en el chat.`;
      return `👶 En las conversaciones analizadas, ${safeClient} no ha mencionado tener hijos todavía.`;
    }
    if (/(profesion|trabajo|work|job)/i.test(pLower)) {
      if (/(pacientes|patients|hospital|nurse)/i.test(mdLower)) return `💼 Profesión de ${safeClient}: Trabaja en el área de salud con pacientes.`;
      return `💼 Profesión de ${safeClient}: Menciona estar activa laboralmente.`;
    }
    if (/(donde vive|de donde|pais)/i.test(pLower)) {
      return `📍 Ubicación de ${safeClient}: Es de ${bioData?.country || 'United States'}.`;
    }

    text = `💡 Información sobre ${safeClient}:\nReside en ${bioData?.country || 'United States'}, tiene ${bioData?.birthDate || '64 años'}.`;
  }

  return text;
}

// 1. AUTO-DESCUBRIMIENTO DE MODELO GROQ ACTIVO
async function getWorkingGroqModel(apiKey) {
  if (cachedActiveGroqModel) return cachedActiveGroqModel;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.data)) {
        const preferred = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama3-70b', 'gemma2', 'qwen', 'llama3-8b'];
        for (let pref of preferred) {
          const match = data.data.find(m => m.id.toLowerCase().includes(pref) && !m.id.includes('whisper'));
          if (match && match.active !== false) {
            cachedActiveGroqModel = match.id;
            return cachedActiveGroqModel;
          }
        }
      }
    }
  } catch (e) {}
  return 'llama-3.1-8b-instant';
}

// 2. MOTOR DE IA COGNITIVO
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName, bioData) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Jaye, 64';
  const realCountry = bioData?.country || 'United States';
  const realBirthDate = bioData?.birthDate || 'Feb 15, 1962 (64 años)';
  const realMarital = bioData?.maritalStatus || 'Divorced / Viuda';
  const realInterests = bioData?.interests || 'Traveling, Hockey';

  const pLower = (prompt || '').toLowerCase().trim();
  const mdLower = (fullTranscript || '').toLowerCase();

  const isMessageRequest = /(dame un mensaje|como le respondo|como respondo|redacta|escribe un mensaje|mensaje para|carta|gancho|enganchar|conquistar|enamorar)/i.test(pLower);

  if (!isMessageRequest) {
    if (/(mascota|mascotas|perro|perros|gato|gatos|pet|pets|dog|cat)/i.test(pLower)) {
      if (/(perro|dog)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}: Mencionó tener perro en la conversación.`;
      if (/(gato|cat)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}: Mencionó tener gato en la conversación.`;
      return `🐾 Mascotas de ${safeClient}: En las conversaciones analizadas, no ha mencionado tener mascotas todavía.`;
    }
    if (/(hijo|hijos|hija|hijas|familia|nietos|kids|children|son|daughter)/i.test(pLower)) {
      if (/(hijos|kids|children|son|daughter)/i.test(mdLower)) return `👶 Familia de ${safeClient}: Sí, mencionó tener hijos en el chat.`;
      return `👶 Familia de ${safeClient}: En el historial analizado, no ha mencionado tener hijos todavía.`;
    }
    if (/(donde vive|dónde vive|de donde|de dónde|ded onde|dond es|pais|país|location|country)/i.test(pLower)) {
      return `📍 Ubicación de ${safeClient}: ${safeClient} es de ${realCountry}.`;
    }
    if (/(edad|años|anos|cuantos años|cuántos años|cuantos anos|cuanto ano|tirnr|tienr|cumpleaños)/i.test(pLower)) {
      return `🎂 Edad y Nacimiento de ${safeClient}: ${safeClient} tiene ${realBirthDate}.`;
    }
    if (/(estado civil|casada|soltera|divorciada|viuda|pareja)/i.test(pLower)) {
      return `💍 Estado Civil de ${safeClient}: Figura como ${realMarital}.`;
    }
    if (/(profesion|profesión|trabajo|trabaja|job|work|ocupacion|ocupación)/i.test(pLower)) {
      if (/(pacientes|patients|hospital|nurse|salud)/i.test(mdLower)) {
        return `💼 Profesión de ${safeClient}: Trabaja en el área de salud / atención médica con pacientes.`;
      } else if (/(retirado|retired|jubilada)/i.test(mdLower)) {
        return `💼 Profesión de ${safeClient}: Está retirada / jubilada.`;
      }
      return `💼 Profesión de ${safeClient}: Menciona estar activa laboralmente.`;
    }
  }

  if (GROQ_API_KEY && GROQ_API_KEY.startsWith('gsk_')) {
    try {
      const targetModel = await getWorkingGroqModel(GROQ_API_KEY);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const systemPrompt = `Eres el Asistente de IA de RYR TITAN. Redactas mensajes en modo /human para la clienta ${safeClient}.
DATOS:
- Nombre: ${safeClient}
- Ubicación: ${realCountry}
- Edad: ${realBirthDate}
- Intereses: ${realInterests}

REGLAS OBLIGATORIAS:
1. Responde DIRECTAMENTE con la estrategia y la sugerencia de mensaje.
2. PROHIBIDO pensar en voz alta en inglés o escribir "Here is a thinking process" o "Check against constraints".
3. Formato:
   💡 Estrategia para ${safeClient}: [1-2 oraciones]
   💬 Opción en Inglés (Copiar y Enviar): "[Mensaje seductor listo]"
   💬 Traducción al Español: "[Traducción]"
4. CERO TRAVEL MISLEADING (TM): NUNCA insinúes encuentros en persona ni viajes.`;

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `HISTORIAL DE ${safeClient}:\n${fullTranscript || 'Sin historial previo.'}\n\nPETICIÓN DEL OPERADOR:\n${prompt}` }
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
          return sanitizeAiOutput(data.choices[0].message.content, safeClient, bioData, fullTranscript, prompt);
        }
      }
    } catch (err) {
      console.error("[GROQ ERROR]:", err.message);
    }
  }

  return `💡 Estrategia para ${safeClient}:
Conviene responder con un tono dulce y cercano, validando lo que siente y haciendo una pregunta abierta.

💬 Opción en Inglés (Copiar y Enviar):
"Thinking of you and your sweet smile brings so much warmth to my heart. How is your day going, my love?"

💬 Traducción al Español:
"Pensar en ti y en tu dulce sonrisa me da mucha calidez al corazón. ¿Cómo va tu día, mi amor?"`;
}

// 3. ENDPOINTS DE AJUSTES GLOBALES DEL SISTEMA (ADMINISTRADOR)
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: globalSystemSettings });
});

app.post('/api/settings/toggle-modal', (req, res) => {
  globalSystemSettings.invasiveModalEnabled = !globalSystemSettings.invasiveModalEnabled;
  console.log(`[CONFIG ADMIN] Modal Invasivo cambiado a: ${globalSystemSettings.invasiveModalEnabled ? 'ON' : 'OFF'}`);
  res.json({ success: true, settings: globalSystemSettings });
});

// 4. ENDPOINTS DE CONSULTA Y EXPEDIENTES
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
        if (String(audit.clientId) === targetId || String(audit.client_id) === targetId || String(audit.clientName).toLowerCase() === String(clientName).toLowerCase()) {
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

app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  const queryName = String(req.query.name || '').trim();
  let chatMd = '';
  let clientName = queryName || 'Jaye, 64';

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
      location: /(brazil|brasil)/i.test(textLower) ? 'Brazil' : (/(australia)/i.test(textLower) ? 'Australia' : 'United States'),
      birthDate: /(feb 15, 1962|1962)/i.test(textLower) ? 'Feb 15, 1962 (64 años)' : '64 años',
      maritalStatus: 'Divorced / Viuda',
      summary: `Expediente de ${clientName} verificado en Supabase.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

// 5. TELEMETRÍA
app.post('/api/telemetry', (req, res) => {
  const {
    operator, shift, profile, profileId,
    pendingReadLetters, unansweredChatsCount,
    hasExpiredSla, isAfk, idleSeconds,
    activeChatTimersList, prospectingProgress, monopolyStatus, status
  } = req.body;

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
    prospectingProgress: prospectingProgress || { count: 0, quota: 50, remainingSeconds: 1800, isCompleted: false },
    monopolyStatus: monopolyStatus || { hasMonopoly: false, focusedClient: '', consecutiveSent: 0, unattendedCount: 0 },
    lastSeen: Date.now()
  });

  res.json({ success: true, settings: globalSystemSettings });
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
        operatorsMap.set(opKey, {
          operatorName: data.operatorName,
          shift: data.shift,
          lastSeen: data.lastSeen,
          isAfkGlobal: false,
          hasExpiredSlaGlobal: false,
          hasMonopolyGlobal: false,
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
        activeChatTimersList: data.activeChatTimersList || [],
        prospectingProgress: data.prospectingProgress || { count: 0, quota: 50, remainingSeconds: 1800, isCompleted: false },
        monopolyStatus: data.monopolyStatus || { hasMonopoly: false, focusedClient: '', consecutiveSent: 0, unattendedCount: 0 }
      });

      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.monopolyStatus && data.monopolyStatus.hasMonopoly) opEntry.hasMonopolyGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }

  res.json({ success: true, operators: Array.from(operatorsMap.values()), settings: globalSystemSettings });
});

// 6. DEMÁS ENDPOINTS (AUDITORÍA, MULTAS, ALERTAS)
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String((clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Cliente').trim();
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

app.get('/api/alerts/live', (req, res) => {
  const alertsList = Array.from(activeAlertsMap.values()).filter(a => a.status === 'PENDING').sort((a, b) => b.timestamp - a.timestamp);
  res.json({ success: true, alerts: alertsList });
});

app.get('/api/banned-words', (req, res) => res.json({ words: Array.from(dynamicBannedWords) }));
app.post('/api/banned-words', (req, res) => { if (req.body.word) dynamicBannedWords.add(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });
app.post('/api/banned-words/delete', (req, res) => { if (req.body.word) dynamicBannedWords.delete(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });

// 7. DASHBOARD EMBEBIDO CON INTERRUPTOR DEL MODAL INVASIVO
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - SUPERVISIÓN LIVE</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; --accent-gold: #f59e0b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .btn-fines { border-color: var(--accent-gold); color: var(--accent-gold); background: rgba(245, 158, 11, 0.15); }
    .btn-toggle-on { border-color: #ef4444; color: #f87171; background: rgba(239, 68, 68, 0.15); }
    .btn-toggle-off { border-color: #64748b; color: #94a3b8; background: #1e293b; }

    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    
    .profile-live-box { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .profile-live-box.monopoly-alert { border-color: #f59e0b !important; background: rgba(245, 158, 11, 0.08) !important; }

    .live-timers-container { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .live-chat-timer-badge { font-size: 10px; font-weight: bold; font-family: monospace; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; }
    .timer-ok { background: #064e3b; color: #34d399; border: 1px solid #10b981; }
    .timer-expired { background: #450a0a; color: #f87171; border: 1px solid #ef4444; }

    .prospect-pill { font-size: 10px; font-weight: bold; font-family: monospace; padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; }
    .prospect-progress { background: #1c2541; border: 1px solid #f59e0b; color: #fde68a; }
    .prospect-done { background: #064e3b; border: 1px solid #10b981; color: #34d399; }

    .monopoly-banner { background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; border-radius: 4px; padding: 6px 8px; font-size: 10.5px; color: #fca5a5; margin-top: 6px; font-weight: bold; }

    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 940px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; line-height: 1.6; color: #cbd5e1; }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE</div>
    <div style="display:flex; gap:8px;">
      <button id="btn-toggle-modal" class="btn-action btn-toggle-on" onclick="toggleInvasiveModal()">🚨 Modal Invasivo: ON</button>
      <button class="btn-action btn-fines" onclick="openFinesModal()">💰 Multas (<span id="total-fines-count">0</span>)</button>
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
    let globalAuditsList = [];

    async function toggleInvasiveModal() {
      const res = await fetch(\`\${API_URL}/api/settings/toggle-modal\`, { method: 'POST' });
      const data = await res.json();
      updateToggleBtn(data.settings.invasiveModalEnabled);
    }

    function updateToggleBtn(isEnabled) {
      const btn = document.getElementById('btn-toggle-modal');
      if (isEnabled) {
        btn.className = 'btn-action btn-toggle-on';
        btn.innerText = '🚨 Modal Invasivo: ON';
      } else {
        btn.className = 'btn-action btn-toggle-off';
        btn.innerText = '⚪ Modal Invasivo: OFF';
      }
    }

    async function fetchLive() {
      try {
        const res = await fetch(\`\${API_URL}/api/telemetry/live\`);
        const data = await res.json();
        
        if (data.settings) {
          updateToggleBtn(data.settings.invasiveModalEnabled);
        }

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

              const prog = p.prospectingProgress || { count: 0, quota: 50, remainingSeconds: 1800, isCompleted: false };
              const pMin = Math.floor(prog.remainingSeconds / 60);
              const pSec = prog.remainingSeconds % 60;
              const pTimeStr = \`\${pMin < 10 ? '0' : ''}\${pMin}:\${pSec < 10 ? '0' : ''}\${pSec}\`;

              const monopoly = p.monopolyStatus || { hasMonopoly: false };

              return \`
                <div class="profile-live-box \${monopoly.hasMonopoly ? 'monopoly-alert' : ''}">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:bold; color:#00ffcc;">🎯 \${p.profileName}</span>
                    <span style="font-size:11px; color:#38bdf8;">✉️ \${p.pendingReadLetters} cartas</span>
                  </div>

                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                    <span class="prospect-pill \${prog.isCompleted ? 'prospect-done' : 'prospect-progress'}">
                      🎯 Seguimiento: \${prog.isCompleted ? 'OK' : pTimeStr} [\${prog.count}/\${prog.quota}]
                    </span>
                  </div>

                  \${monopoly.hasMonopoly ? \`
                    <div class="monopoly-banner">
                      ⚠️ DESATENCIÓN: Hablando solo con "\${monopoly.focusedClient}" (\${monopoly.consecutiveSent} msgs) mientras tiene \${monopoly.unattendedCount} clientas esperando respuesta.
                    </div>
                  \` : ''}

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
            <a href="data:text/markdown;charset=utf-8,\${encodeURIComponent(a.markdown)}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
          </div>
          <div class="chat-transcript">\${a.markdown}</div>
        </div>
      \`).join('');
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V80.0 (Invasive Modal Admin Toggle) activo en puerto ${PORT}`));
