const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

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

// 1. MOTOR DE IA HEURÍSTICO
function runDeepAiPatternAnalysis(operator, profile, clientName, clientId, markdown) {
  const textLower = (markdown || '').toLowerCase();
  const findings = [];
  let qualityScore = 100;
  let riskLevel = 'BAJO';

  // Coacción de regalos
  if (/(?:si me quisieras|si me amaras|envíame un regalo|mandame un regalo|dame un regalo|cómprame un regalo|send me a gift|buy me a present)/i.test(textLower)) {
    findings.push({ title: '🛑 Coacción por Regalos', description: 'Petición directa de regalos detectada en el diálogo.' });
    qualityScore -= 35;
    riskLevel = 'CRÍTICO';
  }

  // Incomodidad
  if (/(?:por qué me hablas así|por que me tratas así|no te acuerdas de mí|olvidaste mi nombre|solo quieres mi dinero|you forgot my name|you are rude)/i.test(textLower)) {
    findings.push({ title: '💔 Incomodidad Manifiesta del Cliente', description: 'Reclamo explícito del usuario en el historial.' });
    qualityScore -= 25;
    if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
  }

  // Hostilidad
  if (/(?:cállate|callate|no me importa|qué pereza|que pereza|apúrate|apurate|no tengo tiempo|fastidio|idiota|shut up|waste of time)/i.test(textLower)) {
    findings.push({ title: '🚨 Maltrato / Tono Hostil', description: 'Lenguaje inapropiado o agresivo detectado.' });
    qualityScore -= 30;
    riskLevel = 'CRÍTICO';
  }

  // Palabras prohibidas
  for (let word of dynamicBannedWords) {
    if (textLower.includes(word.toLowerCase())) {
      findings.push({ title: '🛑 Palabra Prohibida', description: `Se detectó la palabra: "${word}".` });
      qualityScore -= 25;
      if (riskLevel !== 'CRÍTICO') riskLevel = 'ALTO';
      break;
    }
  }

  qualityScore = Math.max(0, qualityScore);

  let diagnosis = 'Conversación fluida y respetuosa.';
  let recommendation = 'Mantener la dinámica actual.';

  if (riskLevel === 'CRÍTICO') {
    diagnosis = 'Conversación de ALTO RIESGO: Infracciones graves detectadas.';
    recommendation = 'Intervenir al operador de inmediato y corregir conducta.';
  } else if (riskLevel === 'ALTO') {
    diagnosis = 'Conversación con fricción o desinterés.';
    recommendation = 'Pedir al operador mayor empatía y preguntas abiertas.';
  }

  return {
    score: qualityScore,
    riskLevel: riskLevel,
    diagnosis: diagnosis,
    recommendation: recommendation,
    findings: findings
  };
}

// 2. ENDPOINT: VERIFICAR CHATS EN SUPABASE
app.get('/api/chats/synced-ids', async (req, res) => {
  const profile = req.query.profile;
  const syncedSet = new Set(syncedClientsRegistry);

  if (SUPABASE_URL && SUPABASE_KEY && profile) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?profile_name=eq.${profile}&select=client_id`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data)) {
        data.forEach(d => syncedSet.add(String(d.client_id).trim()));
      }
    } catch (e) {}
  }

  res.json({ success: true, syncedIds: Array.from(syncedSet) });
});

// 3. ENDPOINT: AUDITORÍA Y GUARDADO CON CLAVE ÚNICA NUMÉRICA
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;
  if (!profile || !clientId || !markdown) return res.status(400).json({ error: 'Incompleto' });

  const cleanClientId = String(clientId).trim();
  const auditKey = `${profile}_${cleanClientId}`;
  syncedClientsRegistry.add(cleanClientId);

  const aiReport = runDeepAiPatternAnalysis(operator, profile, clientName, cleanClientId, markdown);

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: clientName || 'Cliente',
    client_id: cleanClientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: aiReport.findings.map(f => f.title),
    has_breach: aiReport.riskLevel === 'CRÍTICO' || aiReport.riskLevel === 'ALTO',
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(auditKey, { ...auditPayload, operator, profile, clientName, clientId: cleanClientId, timestamp: Date.now() });

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(auditPayload)
    }).catch(() => {});
  }

  res.json({ success: true, clientId: cleanClientId, aiReport });
});

// 4. ENDPOINT: ANÁLISIS DE IA
app.post('/api/chats/analyze-single', (req, res) => {
  const { operator, profile, clientName, clientId, markdown } = req.body;
  const aiReport = runDeepAiPatternAnalysis(operator, profile, clientName, clientId, markdown);
  res.json({ success: true, aiReport });
});

// 5. BÚSQUEDA INTELIGENTE HÍBRIDA (POR ID Y POR NOMBRE)
app.get('/api/intelligence/user/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId).trim();
  let chatMd = '';
  let clientFoundName = 'Cliente';

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      // Buscar primero por client_id exacto, si no encuentra, buscar por coincidencia
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?or=(client_id.eq.${clientId},id.ilike.%${clientId}%)&limit=1`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const data = await resp.json();
      if (Array.isArray(data) && data[0]) {
        chatMd = data[0].markdown;
        clientFoundName = data[0].client_name;
      }
    } catch (e) {}
  }

  if (!chatMd) {
    for (let audit of recentChatAuditsRAM.values()) {
      if (String(audit.clientId) === clientId || String(audit.client_id) === clientId || String(audit.clientName).toLowerCase().includes(clientId.toLowerCase())) {
        chatMd = audit.markdown;
        clientFoundName = audit.clientName;
        break;
      }
    }
  }

  if (chatMd) {
    const textLower = chatMd.toLowerCase();
    const dossier = {
      clientName: clientFoundName,
      maritalStatus: /(divorced|divorciado)/i.test(textLower) ? '💔 Divorciado' : (/(widowed|viudo)/i.test(textLower) ? '🕊️ Viudo' : '👤 Soltero / No especificado'),
      pets: /(perro|dog)/i.test(textLower) ? '🐶 Tiene perro' : (/(gato|cat)/i.test(textLower) ? '🐱 Tiene gato' : '🐾 No detectado aún'),
      family: /(hijos|kids|son|daughter)/i.test(textLower) ? '👶 Tiene hijos' : 'No especificado',
      work: /(retirado|retired)/i.test(textLower) ? '🏖️ Retirado' : (/(business|negocio)/i.test(textLower) ? '💼 Negocio propio' : 'Trabajando'),
      summary: 'Conversación sincronizada y disponible en Supabase.'
    };
    return res.json({ success: true, dossier });
  }

  res.json({ success: false, dossier: null });
});

app.post('/api/intelligence/query', async (req, res) => {
  const { query, clientId } = req.body;
  const targetId = String(clientId || '').trim();
  let chatMd = '';

  if (SUPABASE_URL && SUPABASE_KEY && targetId && targetId !== 'N/A') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?or=(client_id.eq.${targetId},id.ilike.%${targetId}%)&limit=1`, {
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

  if (!chatMd) {
    return res.json({ answer: `No hay conversaciones guardadas para el cliente ID ${targetId}. Haz clic en ⚡ para extraer su historial.` });
  }

  const textLower = chatMd.toLowerCase();
  let answer = `📋 **Datos encontrados para el Cliente:**\n`;
  if (/(perro|dog|gato|cat|mascota)/i.test(textLower)) answer += `- 🐾 **Mascotas:** Mencionó tener mascotas.\n`;
  if (/(hijos|kids|son|daughter|nietos)/i.test(textLower)) answer += `- 👶 **Familia:** Mencionó tener hijos/familia.\n`;
  if (/(retirado|retired|trabajo|work|job|business)/i.test(textLower)) answer += `- 💼 **Ocupación:** Mencionó su trabajo/ocupación.\n`;
  if (/(divorced|divorciado|viudo|widowed|single)/i.test(textLower)) answer += `- 💍 **Estado Civil:** Registrado en el chat.\n`;

  res.json({ answer: answer || 'Se analizó el historial. Mantener la conversación fluida.' });
});

// 6. HISTORIAL DE AUDITORÍAS
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

// 7. TELEMETRÍA
app.post('/api/telemetry', (req, res) => {
  const { operator, shift, profile, profileId, pendingReadLetters, unansweredChatsCount, hasExpiredSla, isAfk, idleSeconds, status } = req.body;
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
      opEntry.profiles.push({ profileName: data.profileName, profileId: data.profileId, pendingReadLetters: data.pendingReadLetters, unansweredChatsCount: data.unansweredChatsCount, hasExpiredSla: data.hasExpiredSla, isAfk: data.isAfk, idleSeconds: data.idleSeconds });
      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }
  res.json({ success: true, operators: Array.from(operatorsMap.values()) });
});

app.get('/api/banned-words', (req, res) => res.json({ words: Array.from(dynamicBannedWords) }));
app.post('/api/banned-words', (req, res) => { if (req.body.word) dynamicBannedWords.add(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });
app.post('/api/banned-words/delete', (req, res) => { if (req.body.word) dynamicBannedWords.delete(req.body.word.trim().toLowerCase()); res.json({ success: true, words: Array.from(dynamicBannedWords) }); });

// 8. DASHBOARD EMBEBIDO CON ANALIZADOR IA REPARADO
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RYR TITAN APEX - COMMAND & AI AUDIT CENTER</title>
  <style>
    :root { --bg-main: #060913; --bg-card: #0e1526; --accent-green: #10b981; --accent-cyan: #00ffcc; --accent-red: #ef4444; --accent-purple: #8b5cf6; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-main); color: #fff; font-family: system-ui, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid #1e293b; border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.88); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 940px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; line-height: 1.6; color: #cbd5e1; }
    .ai-report-box { background: #0b132b; border: 1px solid var(--accent-purple); border-radius: 8px; padding: 14px; margin-top: 10px; }
    .score-badge { font-size: 16px; font-weight: 900; padding: 4px 10px; border-radius: 6px; display: inline-block; margin-bottom: 8px; }
    .score-good { background: #064e3b; color: #34d399; border: 1px solid #10b981; }
    .score-bad { background: #450a0a; color: #f87171; border: 1px solid #ef4444; }
  </style>
</head>
<body>
  <header>
    <div style="font-size:14px; font-weight:900; color:var(--accent-cyan);">⚡ RYR TITAN APEX - COMMAND & AI AUDIT CENTER</div>
    <div style="display:flex; gap:8px;">
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Historial de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
    </div>
  </header>

  <div id="operators-grid" class="grid-operators"></div>

  <!-- MODAL HISTORIAL DE CHATS CON ANALIZADOR IA -->
  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:8px;">
        <span style="font-weight:bold; color:var(--accent-cyan);">📄 AUDITORÍA HISTÓRICA & ANÁLISIS DE IA DE PATRONES</span>
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
            \${op.profiles.map(p => \`
              <div style="background:#060913; border:1px solid #1e293b; border-radius:6px; padding:6px 8px; margin-bottom:6px; display:flex; justify-content:space-between;">
                <span>🎯 \${p.profileName}</span>
                <span style="font-size:11px; color:#38bdf8;">✉️ \${p.pendingReadLetters} cartas</span>
              </div>\`).join('')}
          </div>
        \`).join('');
      } catch (e) {}
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
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-weight:bold; color:var(--accent-cyan);">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (ID: \${a.clientId})</span>
            <div style="display:flex; gap:6px;">
              <button class="btn-action" style="background:#1e1b4b; border-color:#8b5cf6; color:#c4b5fd;" onclick="runAiAnalysisByIndex(\${index})">🔍 Analizar con IA</button>
              <a href="data:text/markdown;charset=utf-8,\${encodeURIComponent(a.markdown)}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
            </div>
          </div>
          <div id="ai-box-\${index}"></div>
          <div class="chat-transcript">\${a.markdown}</div>
        </div>
      \`).join('');
    }

    async function runAiAnalysisByIndex(index) {
      const audit = globalAuditsList[index];
      if (!audit) return;

      const box = document.getElementById('ai-box-' + index);
      box.innerHTML = '<p style="color:#c4b5fd; font-size:12px; margin:8px 0;">🤖 Analizando patrones con IA...</p>';

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
          <div class="ai-report-box">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="score-badge \${isGood ? 'score-good' : 'score-bad'}">🎯 Puntaje IA: \${r.score}/100 [Riesgo: \${r.riskLevel}]</span>
            </div>
            <div style="font-size:12px; margin-bottom:4px;"><b>🧠 Diagnóstico:</b> \${r.diagnosis}</div>
            <div style="font-size:12px; color:#38bdf8; margin-bottom:8px;"><b>📋 Recomendación:</b> \${r.recommendation}</div>
            \${r.findings.map(f => \`
              <div style="background:rgba(239,68,68,0.1); border-left:3px solid #ef4444; padding:6px 10px; border-radius:4px; font-size:11px; margin-bottom:4px;">
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

app.listen(PORT, () => console.log(`🚀 RYR TITAN BACKEND V11.0 activo en puerto ${PORT}`));
