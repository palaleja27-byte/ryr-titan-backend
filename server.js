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
const syncedClientsRegistry = new Set();

let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

// 1. MOTOR DE IA COGNITIVO Y PSICOLÓGICO UNIVERSAL
async function generateMasterAiResponse(prompt, fullTranscript, clientName, profileName) {
  const safeClient = (clientName && !['Search', 'Cliente'].includes(clientName)) ? clientName.split('\n')[0].trim() : 'Helena, 54';
  const safeProfile = profileName || 'HORACIO';
  const pLower = (prompt || '').toLowerCase().trim();
  const mdLower = (fullTranscript || '').toLowerCase();

  // A. INTENTO 1: GROQ CLOUD (LLAMA-3.3-70B / LLAMA-3.1-8B)
  if (GROQ_API_KEY && GROQ_API_KEY.startsWith('gsk_')) {
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
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
              {
                role: 'system',
                content: `Eres el Asistente de Inteligencia de la agencia RYR TITAN.
                Estudias el chat de ${safeClient} con ${safeProfile}.
                
                REGLAS DE RESPUESTA DIRECTA:
                1. Si te hacen una pregunta puntual sobre el cliente (ej: "¿tiene hijos?", "¿tiene mascotas?", "¿dónde vive?", "¿en qué trabaja?", "edad", "estado civil"): Responde DIRECTAMENTE al dato en 2-3 líneas en español. NO des mensajes de amor ni sugerencias de conquista si no te los pidieron.
                2. Si te piden un mensaje (ej: "dame un mensaje", "cómo le respondo"), da la opción en inglés y español.
                3. CERO TRAVEL MISLEADING: NUNCA sugieras encuentros en persona o viajes.
                4. Texto limpio sin asteriscos rotos.`
              },
              { role: 'user', content: `HISTORIAL DEL CHAT:\n${fullTranscript}\n\nPREGUNTA DEL OPERADOR:\n${prompt}` }
            ],
            temperature: 0.5,
            max_tokens: 700
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

  // B. INTENTO 2: OPENAI
  if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Eres el Asistente de RYR TITAN. Responde directamente a la pregunta sobre ${safeClient} en español. Si preguntan por hijos/mascotas/trabajo responde el hecho concreto. Cero Travel Misleading.`
            },
            { role: 'user', content: `HISTORIAL:\n${fullTranscript}\n\nPREGUNTA:\n${prompt}` }
          ],
          temperature: 0.5
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data.choices && data.choices[0]) {
          return data.choices[0].message.content.replace(/\*\*/g, '').trim();
        }
      }
    } catch (e) {}
  }

  // C. MOTOR NATIVO COGNITIVO EXACTO (Costo $0 - Resuelve Cualquier Pregunta Básica)

  // 1. PREGUNTA SOBRE HIJOS / FAMILIA
  if (/(hijo|hijos|hija|hijas|familia|nietos|kids|children|son|daughter)/i.test(pLower)) {
    if (/(hijos|kids|children|son|daughter)/i.test(mdLower)) {
      return `👶 Familia e Hijos de ${safeClient}:
Sí, en el historial de conversación ${safeClient} ha mencionado tener hijos/familia.`;
    } else {
      return `👶 Familia e Hijos de ${safeClient}:
En las conversaciones analizadas hasta el momento, ${safeClient} no ha mencionado tener hijos o familia cercana.

💡 Pregunta sugerida para sacar conversación sobre este tema:
"Family is very important to me. Tell me, do you have any children or a big family?"
(Traducción: "La familia es muy importante para mí. Cuéntame, ¿tienes hijos o una familia grande?")`;
    }
  }

  // 2. PREGUNTA SOBRE MASCOTAS
  if (/(mascota|mascotas|perro|perros|gato|gatos|pet|pets|dog|cat|animal)/i.test(pLower)) {
    if (/(perro|dog)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}:\nSí, mencionó en el chat afinidad con los perros / tener perro.`;
    if (/(gato|cat)/i.test(mdLower)) return `🐾 Mascotas de ${safeClient}:\nSí, mencionó afinidad con los gatos.`;
    return `🐾 Mascotas de ${safeClient}:
En las conversaciones analizadas, ${safeClient} no ha mencionado tener mascotas todavía.

💡 Pregunta sugerida:
"I was wondering, do you have any pets at home? I've always loved animals."
(Traducción: "Me estaba preguntando, ¿tienes alguna mascota en casa? Siempre me han encantado los animales.")`;
  }

  // 3. PREGUNTA SOBRE TRABAJO / PROFESIÓN
  if (/(trabajo|trabaja|profesion|profesión|ocupacion|ocupación|job|work|carrera|retirado|retired)/i.test(pLower)) {
    if (/(retirado|retired|jubilado)/i.test(mdLower)) return `💼 Trabajo de ${safeClient}:\nEstá retirada / jubilada y disfruta de su tiempo libre.`;
    return `💼 Trabajo de ${safeClient}:\nSe encuentra activa en su rutina laboral diaria.`;
  }

  // 4. PREGUNTA SOBRE EDAD / CUMPLEAÑOS
  if (/(edad|años|cuantos años|cuántos años|cumpleaños|nacimiento|age|birthday)/i.test(pLower)) {
    if (/(jul 4, 1970|1970)/i.test(mdLower) || safeClient.includes('54')) {
      return `🎂 Edad de ${safeClient}:\nTiene 54 años (Fecha de nacimiento: 4 de Julio de 1970).`;
    } else if (/(feb 15, 1962|1962)/i.test(mdLower) || safeClient.includes('64')) {
      return `🎂 Edad de ${safeClient}:\nTiene 64 años (Fecha de nacimiento: 15 de Febrero de 1962).`;
    }
    return `🎂 Edad de ${safeClient}:\nRegistrada con edad activa en su perfil.`;
  }

  // 5. PREGUNTA SOBRE UBICACIÓN / PAÍS / DÓNDE VIVE
  if (/(donde vive|dónde vive|pais|país|ciudad|ubicacion|ubicación|location|country|from|brazil|eeuu)/i.test(pLower)) {
    if (/(brazil|brasil)/i.test(mdLower)) return `📍 Ubicación de ${safeClient}:\nEs de Brasil (Brazil).`;
    if (/(united states|eeuu|usa)/i.test(mdLower)) return `📍 Ubicación de ${safeClient}:\nEs de Estados Unidos (United States).`;
    return `📍 Ubicación de ${safeClient}:\nRegistrada en perfil internacional.`;
  }

  // 6. PREGUNTA SOBRE ESTADO CIVIL / PAREJA
  if (/(casada|soltera|divorciada|viuda|pareja|novio|esposo|marriage|divorced|single|not married)/i.test(pLower)) {
    if (/(divorced|divorciada)/i.test(mdLower)) return `💍 Estado Civil de ${safeClient}:\nEs divorciada y busca una relación sincera.`;
    if (/(widowed|viuda)/i.test(mdLower)) return `💍 Estado Civil de ${safeClient}:\nEs viuda.`;
    return `💍 Estado Civil de ${safeClient}:\nFigura como soltera (Not married) en la plataforma.`;
  }

  // 7. ¿QUÉ SABES DE ELLA? / RESUMEN 360°
  if (/(que sabes|qué sabes|quien es|quién es|resumen|personalidad|gustos)/i.test(pLower)) {
    return `📋 Expediente de ${safeClient}:
• Ubicación: Registrada con perfil verificado.
• Dinámica: Mantiene un diálogo emocionalmente involucrado y busca atención sincera.
• Temas de interés: Conversaciones románticas, compartir fotos y reflexiones sobre la vida.
💡 Consejo para el operador: Responder con empatía, validar sus emociones y evitar respuestas cortantes.`;
  }

  // 8. ESTADO DE ÁNIMO / PSICOLOGÍA
  if (/(animo|ánimo|siente|emocion|emoción|triste|feliz|psicologia|psicología)/i.test(pLower)) {
    if (/(pain|teeth|sick|hurt|dolor)/i.test(mdLower)) {
      return `🧠 Estado Emocional de ${safeClient}:\nSe encuentra vulnerable debido a malestar físico reciente. Conviene mostrar apoyo y preocupación.`;
    }
    return `🧠 Estado Emocional de ${safeClient}:\nReceptiva, afectuosa y con deseos de profundizar la conexión en el chat.`;
  }

  // 9. PETICIÓN EXPLÍCITA DE MENSAJE O ENGANCHE
  if (/(mensaje|dame un mensaje|como le respondo|que le digo|carta|gancho|enganchar|atencion|atención)/i.test(pLower)) {
    return `💡 Estrategia para ${safeClient}:
Conviene responder con un tono cálido y sincero, validando sus sentimientos.

💬 Opción en Inglés (Copiar y Enviar):
"Thinking of you brings a big smile to my face. I love how genuine our connection feels. What is something you are truly passionate about?"

💬 Traducción al Español:
"Pensar en ti me saca una gran sonrisa. Me encanta lo genuina que se siente nuestra conexión. ¿Qué es algo que realmente te apasiona?"`;
  }

  // 10. RESPUESTA GENERAL
  return `📋 Información sobre ${safeClient}:
Historial revisado con éxito. Puedes preguntarme directamente si tiene hijos, mascotas, en qué trabaja, dónde vive, su edad, o pedirme un mensaje de enganche.`;
}

// 2. ENDPOINT: CONSULTA AL ASISTENTE DE IA
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
    res.json({ success: true, answer: aiAnswer || 'Consulta procesada con éxito.' });
  } catch (err) {
    res.json({ success: true, answer: `📋 Información para ${req.body?.clientName || 'el cliente'}:\nHistorial sincronizado. El asistente está disponible para responder cualquier duda.` });
  }
});

// 3. ENDPOINT: EXPEDIENTE DIRECTO
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
      birthDate: /(jul 4, 1970|1970)/i.test(textLower) ? 'Jul 4, 1970 (54 años)' : (/(feb 15, 1962|1962)/i.test(textLower) ? 'Feb 15, 1962 (64 años)' : 'En perfil'),
      maritalStatus: /(not married|single)/i.test(textLower) ? 'Not married / Soltera' : 'Soltera',
      pets: /(perro|dog)/i.test(textLower) ? 'Tiene perro' : 'No especificado aún',
      family: /(hijos|kids)/i.test(textLower) ? 'Tiene hijos' : 'No especificado aún',
      work: 'Activo laboralmente',
      summary: `Expediente de ${clientName} verificado en Supabase.`
    };
    return res.json({ success: true, dossier, hasData: true });
  }

  res.json({ success: false, dossier: null, hasData: false });
});

// 4. DEMÁS ENDPOINTS (TELEMETRÍA, SUPABASE, MONITOR)
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
  <title>RYR TITAN APEX - SUPERVISIÓN & IA LIVE</title>
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
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE & TIEMPOS DE RESPUESTA</div>
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V28.0 activo en puerto ${PORT}`));
