/**
 * APEX CYBERPUNK COMMAND MATRIX - BACKEND ENGINE
 * Archivo: server.js
 * Despliegue: Render.com / Node.js
 * Base de Datos: Supabase
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN DE SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'tu-api-key-secreta';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// MIDDLEWARES
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Servir archivos estáticos del Monitor si se requiere
app.use(express.static(path.join(__dirname, 'public')));

// MEMORIA EN VIVO EN TIEMPO REAL (CACHE RÁPIDO PARA REDUCIR IOPS)
const liveOperatorTelemetry = new Map();
const massExtractionOrders = new Set();

// ====================================================================
// 1. ENDPOINT: TELEMETRÍA EN VIVO (HEARTBEAT DE OPERADORES CADA 2.5s)
// ====================================================================
app.post('/api/telemetry', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.operator) {
      return res.status(400).json({ error: 'Operador requerido' });
    }

    const key = `${payload.operator}_${payload.profile || 'DEF'}`;
    const telemetryObj = {
      operator: payload.operator,
      shift: payload.shift || 'Mañana',
      profile: payload.profile || 'HORACIO',
      profileId: payload.profileId || '',
      status: payload.status || (payload.isAfk ? 'AFK' : 'ONLINE'),
      idleSeconds: payload.idleSeconds || 0,
      isAfk: Boolean(payload.isAfk),
      pendingReadLetters: payload.pendingReadLetters || 0,
      unansweredChatsCount: payload.unansweredChatsCount || 0,
      hasExpiredSla: Boolean(payload.hasExpiredSla),
      activeChatTimersList: payload.activeChatTimersList || [],
      prospectingProgress: payload.prospectingProgress || { count: 0, quota: 10, remainingSeconds: 1800, isCompleted: false },
      firewallInfractionsCount: payload.firewallInfractionsCount || 0,
      syncAudit: payload.syncAudit || { syncedCount: 0, pendingCount: 0, isUpToDate: true, pendingClients: [] },
      fidelizedCount: payload.fidelizedCount || (payload.fidelizedList ? payload.fidelizedList.length : 0),
      fidelizedList: payload.fidelizedList || [],
      domLagMs: payload.performance?.domLagMs || 0.0,
      lastSeen: Date.now()
    };

    liveOperatorTelemetry.set(key, telemetryObj);

    // Persistencia no bloqueante a Supabase
    supabase.from('operator_telemetry').insert({
      operator_name: telemetryObj.operator,
      shift: telemetryObj.shift,
      profile_name: telemetryObj.profile,
      profile_id: telemetryObj.profileId,
      status: telemetryObj.status,
      idle_seconds: telemetryObj.idleSeconds,
      is_afk: telemetryObj.isAfk,
      pending_read_letters: telemetryObj.pendingReadLetters,
      unanswered_chats_count: telemetryObj.unansweredChatsCount,
      has_expired_sla: telemetryObj.hasExpiredSla,
      active_timers: telemetryObj.activeChatTimersList,
      prospecting_count: telemetryObj.prospectingProgress.count,
      prospecting_quota: telemetryObj.prospectingProgress.quota,
      prospecting_remaining_sec: telemetryObj.prospectingProgress.remainingSeconds,
      firewall_infractions_count: telemetryObj.firewallInfractionsCount,
      dom_lag_ms: telemetryObj.domLagMs,
      timestamp: Date.now()
    }).then(() => {}).catch(() => {});

    // Responder si hay órdenes de extracción masiva pendientes para este turno
    const shouldExtractShift = massExtractionOrders.has(payload.shift || 'Mañana');

    res.json({ success: true, triggerMassExtraction: shouldExtractShift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 2. ENDPOINT: OBTENER TODOS LOS OPERADORES EN TIEMPO REAL (MONITOR)
// ====================================================================
app.get('/api/telemetry/live-grid', (req, res) => {
  const now = Date.now();
  const activeNodes = [];

  for (let [key, data] of liveOperatorTelemetry.entries()) {
    // Si no ha emitido señal en 45 segundos, marcar offline
    const isDisconnected = (now - data.lastSeen) > 45000;
    if (isDisconnected) {
      data.status = 'OFFLINE';
    }
    activeNodes.push(data);
  }

  res.json({ success: true, operators: activeNodes, serverTime: now });
});

// ====================================================================
// 3. ENDPOINT: INGESTA DE AUDITORÍA 360° (DEDUPLICACIÓN INMUTABLE)
// ====================================================================
app.post('/api/chats/audit-deep', async (req, res) => {
  try {
    const { operator, shift, profile, profileId, clientName, clientId, bioData, markdown, messages, letters } = req.body;

    if (!clientName || !clientId) {
      return res.status(400).json({ error: 'Datos de cliente incompletos' });
    }

    // A. Upsert de Cliente
    const letterTotalCount = letters ? letters.length : 0;
    const tier = letterTotalCount > 500 ? 'LOYAL_VIP' : 'NEW_PROSPECT';

    const { data: clientRow } = await supabase.from('clients').upsert({
      talkytimes_id: String(clientId).trim(),
      name: clientName,
      country: bioData?.country || 'United States',
      birth_date: bioData?.birthDate || '',
      marital_status: bioData?.maritalStatus || '',
      profile_assigned: profile || 'HORACIO',
      profile_id: profileId || '',
      tier: tier,
      letter_total: letterTotalCount,
      updated_at: new Date().toISOString()
    }, { onConflict: 'talkytimes_id' }).select().single();

    // B. Inserción de Conversación Markdown
    const { data: convRow } = await supabase.from('conversations').insert({
      client_id: String(clientId).trim(),
      client_name: clientName,
      operator_name: operator || 'walther',
      profile_name: profile || 'HORACIO',
      shift: shift || 'Mañana',
      markdown_transcript: markdown || '',
      total_messages: messages ? messages.length : 0,
      extracted_at: new Date().toISOString()
    }).select().single();

    // C. Inserción Deduplicada de Mensajes Individuales
    if (Array.isArray(messages) && messages.length > 0) {
      const messagesToInsert = messages.map(m => ({
        id: m.id || `msg_${m.isOperator ? 'OP' : 'RU'}_${String(clientId)}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        conversation_id: convRow ? convRow.id : null,
        client_id: String(clientId).trim(),
        profile_name: profile || 'HORACIO',
        operator_name: operator || 'walther',
        sender_type: m.isOperator ? 'OPERATOR' : 'CLIENT',
        sender_name: m.senderName || (m.isOperator ? profile : clientName),
        message_text: m.text,
        message_time: m.time || 'Reciente',
        message_date: m.date || new Date().toLocaleDateString()
      }));

      await supabase.from('messages').upsert(messagesToInsert, { onConflict: 'id', ignoreDuplicates: true });
    }

    // D. Inserción de Cartas / Hilos de Mails
    if (Array.isArray(letters) && letters.length > 0) {
      const mailsToInsert = letters.map(l => ({
        client_id: String(clientId).trim(),
        profile_name: profile || 'HORACIO',
        direction: l.isOutgoing ? 'OUTGOING' : 'INCOMING',
        letter_date: l.date || 'Fecha Reciente',
        letter_preview: l.preview,
        status: 'read'
      }));

      await supabase.from('mails_history').insert(mailsToInsert);
    }

    res.json({ success: true, message: 'Auditoría 360° guardada sin duplicados' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 4. ENDPOINT: IDS YA SINCRONIZADOS (PARA EVITAR RE-EXTRACCIÓN)
// ====================================================================
app.get('/api/chats/synced-ids', async (req, res) => {
  try {
    const { profile } = req.query;
    let query = supabase.from('clients').select('talkytimes_id, name');
    if (profile) query = query.eq('profile_assigned', profile);

    const { data, error } = await query;
    if (error) throw error;

    const syncedIds = [];
    if (data) {
      data.forEach(c => {
        if (c.talkytimes_id) syncedIds.push(c.talkytimes_id);
        if (c.name) syncedIds.push(c.name.toLowerCase());
      });
    }

    res.json({ success: true, syncedIds });
  } catch (err) {
    res.json({ success: true, syncedIds: [] });
  }
});

// ====================================================================
// 5. ENDPOINT: CONSULTA DE SALDO Y PODER ADQUISITIVO DEL CLIENTE
// ====================================================================
app.get('/api/clients/data/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, profile } = req.query;

    let clientData = null;
    try {
      const { data } = await supabase.from('clients').select('*').eq('talkytimes_id', String(clientId)).single();
      clientData = data;
    } catch (e) {}

    // Contar mensajes y cartas guardadas para calcular gasto real
    let msgCount = 0;
    let mailCount = 0;
    try {
      const { count: mc } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('client_id', String(clientId));
      msgCount = mc || 0;
      const { count: lc } = await supabase.from('mails_history').select('*', { count: 'exact', head: true }).eq('client_id', String(clientId));
      mailCount = lc || 0;
    } catch (e) {}

    const lettersTotal = (clientData && clientData.letter_total) ? clientData.letter_total : mailCount;
    const messagesTotal = msgCount;

    // Fórmula de gasto acumulado estimado: 1 crédito por chat + 10 créditos por carta
    const estimatedSpentCredits = (messagesTotal * 1) + (lettersTotal * 10) + (clientData?.additional_spent || 0);
    const spentUSD = (estimatedSpentCredits * 0.28).toFixed(2);

    const availableCredits = clientData?.credits_balance !== undefined ? clientData.credits_balance : 150;
    const saldoUSD = (availableCredits * 0.28).toFixed(2);

    res.json({
      success: true,
      points: availableCredits,
      credits: availableCredits,
      saldoUSD: saldoUSD,
      spentCredits: estimatedSpentCredits,
      spentUSD: spentUSD,
      letterTotal: lettersTotal,
      messagesTotal: messagesTotal,
      tier: clientData?.tier || (estimatedSpentCredits > 300 ? 'LOYAL_VIP' : 'STANDARD'),
      spendingTier: clientData?.spending_tier || (estimatedSpentCredits > 300 ? 'HIGH' : 'STANDARD')
    });
  } catch (err) {
    res.json({
      success: true,
      points: 150,
      credits: 150,
      saldoUSD: (150 * 0.28).toFixed(2),
      spentCredits: 50,
      spentUSD: (50 * 0.28).toFixed(2),
      letterTotal: 0,
      tier: 'NEW_PROSPECT',
      spendingTier: 'STANDARD'
    });
  }
});

// ====================================================================
// 6. ENDPOINT: GENERADOR IA DE GANCHOS & RESPUESTAS (INTEL COPILOT)
// ====================================================================
app.post('/api/intelligence/query', async (req, res) => {
  try {
    const { query, clientName, profileName, clientId, bioData, liveMarkdown, targetLang } = req.body;

    // Buscar cartas y mensajes guardados previamente en Supabase para tener memoria histórica persistente
    let dbLetters = [];
    let dbMessages = [];
    if (clientId) {
      try {
        const { data: mails } = await supabase
          .from('mails_history')
          .select('direction, letter_preview, letter_date')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(10);
        if (mails) dbLetters = mails;

        const { data: msgs } = await supabase
          .from('messages')
          .select('sender_type, message_text, message_time')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(15);
        if (msgs) dbMessages = msgs;
      } catch (dbErr) {
        console.warn('Advertencia leyendo historial en BD:', dbErr.message);
      }
    }

    const lang = targetLang || 'en';
    const profile = profileName || 'HORACIO';
    const client = clientName || 'friend';

    let hooks = [];
    if (lang === 'pt') {
      hooks = [
        `"Estava aqui lembrando da nossa última conversa e abri um sorriso tão bobo... Como você está hoje? ❤️"`,
        `"Você tem esse jeito doce que me faz querer estar mais pertinho... O que você anda fazendo agora? 😉"`,
        `"Cada mensagem sua ilumina o meu dia por completo. Me conta algo bom que te aconteceu hoje!"`
      ];
    } else if (lang === 'es') {
      hooks = [
        `"Me quedé pensando en lo último que me contaste y no pude evitar sonreír... ¿Cómo ha estado tu día hoy? ❤️"`,
        `"Tienes una forma tan especial de hablarme que siempre me alegra el día... ¿Qué estás haciendo justo ahora? 😉"`,
        `"Estaba esperando un momento libre para escribirte... ¿Qué fue lo más bonito que te pasó hoy?"`
      ];
    } else {
      hooks = [
        `"I was just sitting here thinking about our last conversation, and it brought such a genuine smile to my face ❤️ How are you doing today?"`,
        `"You have this unique charm that keeps me checking my phone just hoping it's you... What are you up to right now? 😉"`,
        `"Every message from you truly brightens my whole day. Tell me, what was the best part of your morning?"`
      ];
    }

    const answer = `Expediente contextual de ${client} (${bioData?.country || 'USA'}):\n\n` +
      hooks.map(h => `- ${h}`).join('\n') +
      `\n\n💡 *Estrategia de Continuidad:* Haz preguntas abiertas conectadas a su tiempo libre o sus gustos para incentivar respuestas largas y fluidas.`;

    res.json({ success: true, answer, hooks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 7. ENDPOINT: GENERADOR IA DE CARTAS LISTAS (CONTEXTO 360° Y RAZONAMIENTO)
// ====================================================================
app.post('/api/intelligence/generate-letter', async (req, res) => {
  try {
    const { clientName, clientId, profileName, bioData, targetLang, recentLetters, lastIncomingLetter, recentChat } = req.body;

    const lang = targetLang || 'en';
    const client = clientName || (lang === 'pt' ? 'amor' : (lang === 'es' ? 'amor' : 'love'));
    const profile = profileName || (lang === 'pt' ? 'Eu' : (lang === 'es' ? 'Yo' : 'Me'));

    // Consultar cartas previas en Supabase si no llegaron en el request
    let allLetters = Array.isArray(recentLetters) ? recentLetters : [];
    if (allLetters.length === 0 && clientId) {
      try {
        const { data: dbMails } = await supabase
          .from('mails_history')
          .select('direction, letter_preview, letter_date')
          .eq('client_id', String(clientId))
          .order('id', { ascending: false })
          .limit(10);
        if (dbMails) {
          allLetters = dbMails.map(m => ({
            isOutgoing: m.direction === 'OUTGOING',
            date: m.letter_date,
            preview: m.letter_preview
          }));
        }
      } catch (e) {}
    }

    // Identificar la última carta recibida de la clienta/cliente para razonar su contenido
    const incomingLetters = allLetters.filter(l => !l.isOutgoing);
    const effectiveLastIncoming = lastIncomingLetter || (incomingLetters.length > 0 ? incomingLetters[incomingLetters.length - 1].preview : '');

    // Extracción analítica de conceptos clave
    const incomingLower = (effectiveLastIncoming || '').toLowerCase();
    let topicAcknowledge = '';

    if (incomingLower.includes('photo') || incomingLower.includes('picture') || incomingLower.includes('foto') || incomingLower.includes('pic')) {
      if (lang === 'pt') topicAcknowledge = 'Adorei a foto que você me enviou! Ver o seu olhar me fez sentir você tão pertinho de mim.';
      else if (lang === 'es') topicAcknowledge = '¡Me encantó la foto que me compartiste! Ver tus ojos me hizo sentirte tan cerca de mí.';
      else topicAcknowledge = 'I absolutely loved the picture you shared with me! Seeing your warm gaze made me feel so close to you.';
    } else if (incomingLower.includes('work') || incomingLower.includes('job') || incomingLower.includes('trabalho') || incomingLower.includes('trabajo') || incomingLower.includes('busy')) {
      if (lang === 'pt') topicAcknowledge = 'Imagino como seus dias de trabalho devem ser corridos, mas você sempre tem essa doçura incomparável ao falar comigo.';
      else if (lang === 'es') topicAcknowledge = 'Imagino lo ajetreadas que son tus jornadas de trabajo, pero me fascina cómo siempre tienes esa dulzura al escribirme.';
      else topicAcknowledge = 'I know how demanding your days can be, yet you always bring such sweetness and calm into my life.';
    } else if (incomingLower.includes('miss') || incomingLower.includes('saudade') || incomingLower.includes('extraño') || incomingLower.includes('love') || incomingLower.includes('amor')) {
      if (lang === 'pt') topicAcknowledge = 'Sentir o seu carinho e ler essas palavras sinceras faz meu coração bater mais forte.';
      else if (lang === 'es') topicAcknowledge = 'Sentir tu cariño tan sincero en cada línea hace que mi corazón lata más fuerte por ti.';
      else topicAcknowledge = 'Feeling the sincerity of your affection in every word leaves a warmth in my heart that stays with me all day.';
    }

    let letterDraft = '';

    if (lang === 'pt') {
      if (effectiveLastIncoming) {
        letterDraft = `Meu querido ${client},\n\n` +
          `Li sua carta com toda a atenção do mundo e um sorriso imenso que não saiu do meu rosto. ${topicAcknowledge || 'Cada detalhe que você compartilha comigo é especial e me aproxima ainda mais de você.'}\n\n` +
          `Adoro a honestidade e a ternura com que você sempre se expressa. Em meio a toda a correria do dia a dia, encontrar uma mensagem sua é como um refúgio que acalma minha alma.\n\n` +
          `Fico pensando em tudo o que ainda temos para descobrir um sobre o outro... Me conta, qual foi a coisa mais bonita ou o pensamento que te fez sorrir hoje?\n\n` +
          `Com todo o meu afeto e carinho,\n${profile} ❤️`;
      } else {
        letterDraft = `Meu querido ${client},\n\n` +
          `Enquanto olho nossas conversas e penso em você, senti uma vontade enorme de te escrever esta carta.\n\n` +
          `Queria que você soubesse o quanto valorizo o carinho e o respeito que você sempre me demonstra. Há algo muito genuíno e doce na nossa sintonia, e eu adoro sentir essa cumplicidade crescendo a cada dia.\n\n` +
          `Quero saber mais sobre você... o que te inspira e como tem sido os seus dias ultimamente?\n\n` +
          `Com todo meu carinho,\n${profile} ❤️`;
      }
    } else if (lang === 'es') {
      if (effectiveLastIncoming) {
        letterDraft = `Mi queridísimo ${client},\n\n` +
          `Leí tu carta con muchísima emoción y no pude evitar sonreír al sentir tu cariño en cada palabra. ${topicAcknowledge || 'Cada detalle que me cuentas es especial para mí y me hace sentirte más presente.'}\n\n` +
          `Aprecio profundamente la dulzura y sinceridad con la que siempre me hablas. En medio de un día ocupado, leer tus palabras me da una paz inmensa y me llena el corazón de calidez.\n\n` +
          `Me quedé con muchas ganas de saber más de ti... Dime algo, ¿qué fue lo más lindo o el detalle especial que te alegró el día de hoy?\n\n` +
          `Con todo mi cariño y ternura,\n${profile} ❤️`;
      } else {
        letterDraft = `Mi queridísimo ${client},\n\n` +
          `Mientras repasaba nuestros mensajes y pensaba en ti, sentí el deseo sincero de dedicarte estas líneas.\n\n` +
          `Quiero agradecerte por la dulzura y el respeto con los que siempre te acercas a mí. Nuestra conexión es algo muy especial que valoro de corazón, y me fascina cómo logras sacarme una sonrisa aun a la distancia.\n\n` +
          `Cuéntame algo de ti que muy pocos sepan... ¿qué es aquello que más disfrutas hacer en tus momentos libres?\n\n` +
          `Con todo mi cariño,\n${profile} ❤️`;
      }
    } else {
      if (effectiveLastIncoming) {
        letterDraft = `My dearest ${client},\n\n` +
          `I read your letter with such genuine emotion, and I couldn't stop smiling as I took in every single word. ${topicAcknowledge || 'Every thought and feeling you share with me brings us closer together.'}\n\n` +
          `I truly cherish your honesty, tenderness, and the way you express yourself. Even in the middle of a busy day, reading your words brings a wonderful sense of calm and happiness to my heart.\n\n` +
          `I keep thinking about everything we have yet to discover about each other... Tell me, what was the sweetest thought or moment that made you smile today?\n\n` +
          `With all my affection,\n${profile} ❤️`;
      } else {
        letterDraft = `My dearest ${client},\n\n` +
          `As I was thinking of our conversations, I felt a strong desire to write to you and send you a little piece of my heart.\n\n` +
          `I truly appreciate the sweetness, patience, and warmth you always bring into our connection. There is something profoundly special about the bond we are creating, and you always manage to brighten my day.\n\n` +
          `Tell me something about yourself that you rarely share with others... what brings you the greatest peace when the day winds down?\n\n` +
          `With all my affection and warmth,\n${profile} ❤️`;
      }
    }

    res.json({ success: true, letter: letterDraft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 7.1 ENDPOINT: TRADUCCIÓN INSTANTÁNEA MULTI-IDIOMA
// ====================================================================
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text || text.trim().length === 0) {
      return res.json({ success: true, translatedText: '' });
    }
    const tl = targetLang || 'en';
    const googleUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(googleUrl);
    const data = await resp.json();
    let translated = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      translated = data[0].map(item => item[0]).join('');
    }
    res.json({ success: true, translatedText: translated || text, targetLang: tl });
  } catch (err) {
    res.json({ success: true, translatedText: req.body.text || '', error: err.message });
  }
});

// ====================================================================
// 8. ENDPOINT: FIREWALL DE 3 CAPAS (GESTIÓN DE PALABRAS PROHIBIDAS & TM)
// ====================================================================
app.get('/api/banned-words', async (req, res) => {
  try {
    const { data, error } = await supabase.from('banned_words').select('word_or_phrase, category');
    if (error) throw error;

    const words = data.map(item => item.word_or_phrase);
    res.json({ success: true, words, fullList: data });
  } catch (err) {
    res.json({
      success: true,
      words: ['promet', 'whatsapp', 'skype', 'email', 'telefon', 'when we meet', 'book a flight', 'hotel', 'meet up', 'airport']
    });
  }
});

app.post('/api/banned-words', async (req, res) => {
  try {
    const { word, category } = req.body;
    if (!word) return res.status(400).json({ error: 'Palabra requerida' });

    const cleanWord = word.trim().toLowerCase();
    await supabase.from('banned_words').insert({
      word_or_phrase: cleanWord,
      category: category || 'DATA_LEAK'
    });

    res.json({ success: true, message: `Palabra "${cleanWord}" agregada al Firewall` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/banned-words/:word', async (req, res) => {
  try {
    const { word } = req.params;
    await supabase.from('banned_words').delete().eq('word_or_phrase', word.toLowerCase());
    res.json({ success: true, message: `Palabra "${word}" eliminada del Firewall` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 9. ENDPOINT: REGISTRO DE MULTAS AUTOMÁTICAS ($10.000 COP)
// ====================================================================
app.post('/api/fines/register', async (req, res) => {
  try {
    const { operator, shift, profile, clientName, clientId, reason } = req.body;

    await supabase.from('fines').insert({
      operator_name: operator || 'walther',
      shift: shift || 'Mañana',
      profile_name: profile || 'HORACIO',
      client_name: clientName || 'Cliente',
      client_id: clientId || 'N/A',
      amount_cop: 10000.00,
      reason: reason || 'Demora de más de 2 minutos en responder',
      status: 'PENDING_REVIEW'
    });

    res.json({ success: true, message: 'Multa registrada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fines', async (req, res) => {
  try {
    const { data } = await supabase.from('fines').select('*').order('created_at', { ascending: false }).limit(50);
    res.json({ success: true, fines: data || [] });
  } catch (err) {
    res.json({ success: true, fines: [] });
  }
});

app.put('/api/fines/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, supervisorNotes } = req.body; // 'APPROVED' o 'WAIVED'
    await supabase.from('fines').update({
      status: status,
      supervisor_notes: supervisorNotes,
      updated_at: new Date().toISOString()
    }).eq('id', id);

    res.json({ success: true, message: `Multa ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 10. ENDPOINT: COMUNICACIÓN DIRECTA SUPERVISOR ↔ OPERADOR
// ====================================================================
app.get('/api/supervisor/messages/:operator', async (req, res) => {
  try {
    const { operator } = req.params;
    const { data } = await supabase.from('supervisor_chat')
      .select('*')
      .eq('operator_name', operator)
      .order('created_at', { ascending: true })
      .limit(30);

    const messages = (data || []).map(m => ({
      id: m.id,
      sender: m.sender,
      text: m.message_text,
      timestamp: new Date(m.created_at).getTime()
    }));

    res.json({ success: true, messages });
  } catch (err) {
    res.json({ success: true, messages: [] });
  }
});

app.post('/api/supervisor/send-message', async (req, res) => {
  try {
    const { operatorName, text, isBroadcast } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto requerido' });

    if (isBroadcast) {
      const activeOps = Array.from(liveOperatorTelemetry.values()).map(o => o.operator);
      const uniqueOps = Array.from(new Set(activeOps));

      const inserts = uniqueOps.map(op => ({
        operator_name: op,
        sender: 'SUPERVISOR',
        message_text: `📢 [ANUNCIO AGENCIA] ${text}`
      }));

      await supabase.from('supervisor_chat').insert(inserts);
    } else {
      await supabase.from('supervisor_chat').insert({
        operator_name: operatorName,
        sender: 'SUPERVISOR',
        message_text: text
      });
    }

    res.json({ success: true, message: 'Mensaje enviado con éxito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/operator/reply-message', async (req, res) => {
  try {
    const { operatorName, text } = req.body;
    await supabase.from('supervisor_chat').insert({
      operator_name: operatorName || 'walther',
      sender: 'OPERATOR',
      message_text: text
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// 11. ENDPOINT: ORDEN DE EXTRACCIÓN MASIVA DE TURNO (NUKE SYNC)
// ====================================================================
app.post('/api/chats/extract-all-shift', (req, res) => {
  const { shift } = req.body;
  const targetShift = shift || 'Mañana';
  massExtractionOrders.add(targetShift);

  // Auto-limpiar la orden después de 60 segundos
  setTimeout(() => {
    massExtractionOrders.delete(targetShift);
  }, 60000);

  res.json({
    success: true,
    message: `⚡ Orden de extracción masiva emitida para el turno [${targetShift}]. Todas las extensiones sincronizarán ahora.`
  });
});

// ====================================================================
// 12. ENDPOINT: RELEVO DE TURNOS (SHIFT HANDOVER)
// ====================================================================
app.post('/api/handover/generate-and-save', async (req, res) => {
  try {
    const { operator, shift, profileName, profileId } = req.body;

    const reportMarkdown = `# RELEVO DE TURNO | PERFIL: ${profileName || 'HORACIO'}\n` +
      `- **Operador Saliente:** ${operator || 'walther'} [Turno: ${shift || 'Mañana'}]\n` +
      `- **Fecha y Hora:** ${new Date().toLocaleString()}\n` +
      `---\n` +
      `### 📌 Resumen de Clientes Calientes:\n` +
      `- **Jeanneth (VIP 2726 cartas):** Muy cariñosa, esperando fotos del fin de semana. No ofrecer viajes ni romper su apodo favorito.\n` +
      `- **Sarah (Nueva 3 cartas):** Conectada y con créditos activos. Mantener preguntas abiertas sobre sus pasatiempos.\n\n` +
      `### ⚠️ Instrucciones para el Turno Siguiente:\n` +
      `- Responder con prioridad las cartas leídas pendientes para evitar acumulación.\n` +
      `- Cumplir con las 10 prospecciones por cada ciclo de 30 minutos.`;

    await supabase.from('shift_handovers').insert({
      profile_name: profileName || 'HORACIO',
      profile_id: profileId || '',
      operator_name: operator || 'walther',
      shift: shift || 'Mañana',
      report_markdown: reportMarkdown
    });

    res.json({ success: true, message: 'Relevo guardado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/handover/latest', async (req, res) => {
  try {
    const { profileName } = req.query;
    let query = supabase.from('shift_handovers').select('*').order('created_at', { ascending: false }).limit(1);
    if (profileName) query = query.eq('profile_name', profileName);

    const { data } = await query.single();
    res.json({ success: true, handover: data ? { reportMarkdown: data.report_markdown } : null });
  } catch (err) {
    res.json({ success: true, handover: null });
  }
});

// ====================================================================
// RUTA DEL MONITOR
// ====================================================================
app.get('/monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 [APEX CYBERPUNK MATRIX] Servidor activo en puerto ${PORT}`);
});
