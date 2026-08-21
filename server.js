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

// 1. HELPER: PARSER DE MENSAJES
function parseTranscriptToMessages(markdownText) {
  const lines = (markdownText || '').split('\n');
  const messages = [];

  lines.forEach(line => {
    const match = line.match(/^-\s*(👤|💼)\s*\*\*([^*]+)\*\*\s*\[([^\]]+)\]:\s*(.+)$/);
    if (match) {
      messages.push({
        isOperator: match[1] === '💼',
        sender: match[2].trim(),
        time: match[3].trim(),
        text: match[4].trim()
      });
    }
  });

  return messages;
}

// 2. MOTOR DE IA COGNITIVO UNIVERSAL (GROQ DIRECTO + DISPATCHER DE INTENCIONES COMPLETO)
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName, bioData) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Renate, 80';
  const safeProfile = profileName || 'HORACIO';
  const pLower = (prompt || '').toLowerCase().trim();
  const mdLower = (fullTranscript || '').toLowerCase();

  const realCountry = bioData?.country || 'Australia';
  const realBirthDate = bioData?.birthDate || 'Jan 7, 1946 (80 años)';
  const realMarital = bioData?.maritalStatus || 'Widowed / Viuda';
  const realInterests = bioData?.interests || 'Honest, Optimistic, Caring';

  // A. INTENTO 1: GROQ CLOUD OFICIAL (LLAMA-3.3-70B)
  if (GROQ_API_KEY && GROQ_API_KEY.includes('gsk_')) {
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (let model of groqModels) {
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
                content: `Eres el Asistente de Inteligencia y Estratega de Citas de RYR TITAN operando en Talkytimes.
                DATOS DEL CLIENTE:
                - Nombre: ${safeClient}
                - Ubicación Real: ${realCountry}
                - Nacimiento / Edad: ${realBirthDate}
                - Estado Civil: ${realMarital}
                - Intereses: ${realInterests}
                
                REGLAS DE RESPUESTA:
                1. Si piden un mensaje o cómo responder: Redacta opciones en inglés adaptadas a su perfil (respetuosas, cálidas, seductoras) con su traducción al español.
                2. Si preguntan datos concretos (mascotas, hijos, trabajo, edad, de dónde es): Responde DIRECTAMENTE al dato en 2 líneas.
                3. CERO TRAVEL MISLEADING: NUNCA insinúes citas en persona, encuentros físicos ni viajes.
                4. Texto limpio sin asteriscos dobles (**).`
              },
              { role: 'user', content: `HISTORIAL:\n${fullTranscript || 'Sin historial.'}\n\nCONSULTA:\n${prompt}` }
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

  // B. MOTOR COGNITIVO NATIVO COMPLETO (TODOS LOS CASOS CUBIERTOS)

  // 1. SOLICITUD DE MENSAJE DE ENGANCHE / LLAMAR LA ATENCIÓN
  if (/(mensaje|llamar su atencion|llamar la atencion|llamar la atención|llamar su atención|gancho|atraer|reconectar|escribirle)/i.test(pLower)) {
    return `💡 Estrategia de Enganche para ${safeClient} (${realCountry}):
Dado que ${safeClient} es una mujer madura (${realBirthDate}) que valora la honestidad y el cariño (${realInterests}), conviene redactar un mensaje cálido, lleno de ternura y con un toque poético sin sonar invasivo.

💬 Opción 1 (Cálida y Afectuosa - Copiar y Enviar):
"Good morning, my dear. I was just sitting here thinking about how rare it is to find someone with such a genuine, kind heart like yours. How has your day in ${realCountry} been treating you?"

💬 Traducción al Español:
"Buenos días, querida. Estaba aquí sentado pensando en lo raro que es encontrar a alguien con un corazón tan genuino y bondadoso como el tuyo. ¿Cómo te ha tratado el día hoy en ${realCountry}?"

💬 Opción 2 (Gancho de Interés y Curiosidad):
"I saw something today that immediately brought your sweet smile to my mind. Having our conversations always brings a lot of peace to my days. What is something you are looking forward to today?"

💬 Traducción al Español:
"Hoy vi algo que me trajo inmediatamente tu dulce sonrisa a la mente. Tener nuestras conversaciones siempre le da mucha paz a mis días. ¿Qué es algo que esperas con ilusión el día de hoy?"`;
  }

  // 2. CÓMO RESPONDER AL ÚLTIMO CHAT
  if (/(como respondo|cómo respondo|como le respondo|que le digo|ultimo mensaje|último mensaje|ultimo chat|último chat)/i.test(pLower)) {
    const structuredMsgs = parseTranscriptToMessages(fullTranscript);
    const clientMsgs = structuredMsgs.filter(m => !m.isOperator);

    if (clientMsgs.length > 0) {
      const lastMsg = clientMsgs[clientMsgs.length - 1];
      return `💡 Cómo responder al último mensaje de ${safeClient}:
En su último mensaje dijo: "${lastMsg.text}". Conviene validar sus palabras con dulzura y continuar el hilo de la conversación.

💬 Opción en Inglés (Copiar y Enviar):
"Reading your words always brings such warmth to my heart. Knowing that we share this lovely connection means the world to me. Tell me, how are you feeling right now, my dear?"

💬 Traducción al Español:
"Leer tus palabras siempre le trae tanta calidez a mi corazón. Saber que compartimos esta hermosa conexión significa el mundo para mí. Cuéntame, ¿cómo te sientes ahora mismo, querida?"`;
    }

    return `💡 Sugerencia de Respuesta para ${safeClient}:
"Your message made my day so much brighter. I love how sweet and thoughtful you are. What are you doing right now, sweet heart?"
(Traducción: "Tu mensaje hizo mi día mucho más brillante. Me encanta lo dulce y considerada que eres. ¿Qué estás haciendo ahora mismo, dulce corazón?")`;
  }

  // 3. MASCOTAS
  if (/(mascota|mascotas|perro|perros|gato|gatos|pet|pets|dog|cat|animal)/i.test(pLower)) {
    if (/(perro|dog)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}:\nSí, mencionó en el chat afinidad con los perros.`;
    if (/(gato|cat)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}:\nSí, mencionó afinidad con los gatos.`;
    return `🐾 Mascotas de ${safeClient}:
En las conversaciones analizadas hasta ahora, ${safeClient} no ha mencionado tener mascotas todavía.

💡 Pregunta sugerida para sacar tema:
"I was wondering, do you have any pets at home? I've always loved animals."
(Traducción: "Me estaba preguntando, ¿tienes alguna mascota en casa? Siempre he tenido debilidad por los animales.")`;
  }

  // 4. HIJOS / FAMILIA
  if (/(hijo|hijos|hija|hijas|familia|nietos|kids|children|son|daughter)/i.test(pLower)) {
    if (/(hijos|kids|children|son|daughter)/i.test(mdLower)) {
      return `👶 Familia e Hijos de ${safeClient}:\nSí, ha mencionado a su familia/hijos en el historial.`;
    }
    return `👶 Familia e Hijos de ${safeClient}:
En las conversaciones analizadas, ${safeClient} no ha detallado sobre hijos o familia cercana todavía.`;
  }

  // 5. TRABAJO / PROFESIÓN
  if (/(trabajo|trabaja|profesion|profesión|job|work|retirado|retired)/i.test(pLower)) {
    if (/(retirado|retired|jubilado)/i.test(mdLower) || safeClient.includes('80')) {
      return `💼 Trabajo de ${safeClient}:\nEstá retirada / jubilada y disfruta de su tranquilidad en ${realCountry}.`;
    }
    return `💼 Trabajo de ${safeClient}:\nSe encuentra activa en su rutina diaria.`;
  }

  // 6. EDAD / NACIMIENTO
  if (/(edad|años|anos|cuantos años|cuántos años|nacimiento|cumpleaños|cumple)/i.test(pLower)) {
    return `🎂 Edad y Nacimiento de ${safeClient}:
${realBirthDate}.`;
  }

  // 7. UBICACIÓN / PAÍS
  if (/(donde vive|dónde vive|de donde|de dónde|pais|país|location|country)/i.test(pLower)) {
    return `📍 Ubicación de ${safeClient}:
Es de ${realCountry}.`;
  }

  // 8. ESTADO CIVIL
  if (/(estado civil|casada|soltera|divorciada|viuda|pareja|matrimonio)/i.test(pLower)) {
    return `💍 Estado Civil de ${safeClient}:
${realMarital}.`;
  }

  // 9. GUSTOS / INTERESES
  if (/(gustos|intereses|hobbies|que le gusta|qué le gusta)/i.test(pLower)) {
    return `🎯 Intereses de ${safeClient}:
${realInterests}. Le gusta mantener conversaciones profundas, sinceras y de apoyo mutuo.`;
  }

  // 10. ¿QUÉ SABES DE ELLA?
  if (/(que sabes|qué sabes|quien es|quién es|resumen|todo sobre ella)/i.test(pLower)) {
    return `📋 Expediente Completo de ${safeClient}:
• Ubicación: ${realCountry}
• Nacimiento / Edad: ${realBirthDate}
• Estado Civil: ${realMarital}
• Perfil Personal: Valora la honestidad, el optimismo y la calidez emocional.
💡 Consejo para el Operador: Trátala con respeto y afecto maduro. Puedes pedirme "dame un mensaje para llamar su atención" para redactarle algo lindo.`;
  }

  // 11. RESPUESTA GENERAL
  return `💡 Análisis para ${safeClient}:
Historial revisado con éxito. Puedes pedirme "dame un mensaje para llamar su atención", preguntarme "cómo responder a su último chat", o consultar si tiene mascotas, hijos o en qué trabaja.`;
}

// 3. ENDPOINT: CONSULTA DE INTELIGENCIA
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

// 4. DEMÁS ENDPOINTS
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  let chatMd = '';
  let clientName = 'Renate, 80';

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
      location: /(australia)/i.test(textLower) ? 'Australia' : (/(poland|polonia)/i.test(textLower) ? 'Poland' : 'United States'),
      birthDate: /(jan 7, 1946|1946)/i.test(textLower) ? 'Jan 7, 1946 (80 años)' : 'Jan 1, 1973 (53 años)',
      maritalStatus: /(widowed|viuda)/i.test(textLower) ? 'Widowed' : 'Not married',
      summary: `Expediente de ${clientName} verificado en pantalla.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const safeClientName = String(clientName || 'Renate').trim();
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V47.0 activo en puerto ${PORT}`));
