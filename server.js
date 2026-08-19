const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciales automáticas desde las Variables de Entorno de Render
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Memoria RAM rápida para respuesta instantánea (<5ms)
const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();

// Diccionario dinámico de palabras prohibidas
let dynamicBannedWords = new Set([
  'whatsapp', 'skype', 'email', 'correo', 'teléfono', 'telefono', 
  'prometo', 'promesa', 'número', 'numero', 'banco', 'tarjeta', 
  'instagram', 'telegram', 'dinero', 'transferencia', 'pay', 'cash'
]);

const hostilePhrases = [
  'callate', 'cállate', 'no me importa', 'que pereza', 'qué pereza', 'apurate', 'apúrate',
  'no tengo tiempo', 'dejame', 'déjame', 'no fastidies', 'fastidio', 'idiota', 'pesado'
];

// 1. ENDPOINT: TELEMETRÍA DE OPERADORES
app.post('/api/telemetry', (req, res) => {
  const {
    operator, shift, profile, profileId,
    pendingReadLetters, unansweredChatsCount,
    hasExpiredSla, isAfk, idleSeconds, status
  } = req.body;

  if (!operator || !profile) {
    return res.status(400).json({ error: 'Operador y perfil requeridos' });
  }

  const sessionKey = `${operator.toLowerCase().trim()}_${profile.toLowerCase().trim()}`;

  if (status === 'OFFLINE') {
    liveTelemetryMap.delete(sessionKey);
    return res.json({ success: true, message: 'Sesión finalizada' });
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

// 2. ENDPOINT: AUDITORÍA HEURÍSTICA Y GUARDADO EN SUPABASE (UPSERT SIN DUPLICADOS)
app.post('/api/chats/audit-deep', async (req, res) => {
  const { operator, profile, clientName, clientId, markdown, messages } = req.body;

  if (!profile || !clientId || !markdown) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const auditKey = `${profile}_${clientId}`;
  const flags = [];
  const textLower = markdown.toLowerCase();

  // A. Maltrato o Tono Hostil
  for (let phrase of hostilePhrases) {
    if (textLower.includes(phrase)) {
      flags.push(`🚨 Posible Maltrato/Tono Hostil ("${phrase}")`);
      break;
    }
  }

  // B. Palabras Prohibidas
  for (let word of dynamicBannedWords) {
    if (textLower.includes(word)) {
      flags.push(`🛑 Palabra Prohibida ("${word}")`);
      break;
    }
  }

  // C. Oportunidad de Cartas Desperdiciada
  const clientWantsLetters = /(carta|letter|escríbeme|escribeme|foto|story|historia|correo)/i.test(textLower);
  const operatorOfferedLetter = /(te envié una carta|te mandé una carta|check your mail|sent you a letter|revisa tu correo)/i.test(textLower);
  if (clientWantsLetters && !operatorOfferedLetter) {
    flags.push(`💡 Oportunidad de Carta Desperdiciada`);
  }

  // D. Respuestas Monosilábicas
  if (Array.isArray(messages) && messages.length >= 4) {
    const operatorMsgs = messages.filter(m => m.isOperator);
    if (operatorMsgs.length > 0) {
      const avgWords = operatorMsgs.reduce((acc, m) => acc + m.text.split(' ').length, 0) / operatorMsgs.length;
      if (avgWords < 3.5) {
        flags.push(`⚠️ Respuestas Muy Cortas`);
      }
    }
  }

  const hasBreach = flags.some(f => f.startsWith('🚨') || f.startsWith('🛑'));

  const auditPayload = {
    id: auditKey,
    operator_name: operator || 'Desconocido',
    profile_name: profile,
    client_name: clientName || 'Cliente',
    client_id: clientId,
    total_messages: Array.isArray(messages) ? messages.length : 0,
    flags: flags.length > 0 ? flags : ['✅ Conversación Correcta'],
    has_breach: hasBreach,
    markdown: markdown,
    updated_at: new Date().toISOString()
  };

  // Guardar en Memoria RAM para visualización rápida
  recentChatAuditsRAM.set(auditKey, {
    ...auditPayload,
    operator: auditPayload.operator_name,
    profile: auditPayload.profile_name,
    clientName: auditPayload.client_name,
    clientId: auditPayload.client_id,
    timestamp: Date.now()
  });

  // Persistir en Supabase de forma asíncrona sin bloquear la petición
  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/chat_audits`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates' // Evita duplicados (UPSERT)
      },
      body: JSON.stringify(auditPayload)
    }).catch(err => console.error("Error guardando en Supabase:", err));
  }

  res.json({ success: true, audit: auditPayload });
});

// 3. ENDPOINT: LISTAR AUDITORÍAS DE CHATS (Lee de Supabase o RAM)
app.get('/api/chats/audits', async (req, res) => {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/chat_audits?select=*&order=updated_at.desc&limit=60`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      const data = await response.json();
      if (Array.isArray(data)) {
        const formatted = data.map(d => ({
          id: d.id,
          operator: d.operator_name,
          profile: d.profile_name,
          clientName: d.client_name,
          clientId: d.client_id,
          flags: Array.isArray(d.flags) ? d.flags : [],
          hasBreach: d.has_breach,
          markdown: d.markdown,
          timestamp: new Date(d.updated_at).getTime()
        }));
        return res.json({ success: true, audits: formatted });
      }
    } catch (e) {
      console.error("Error leyendo de Supabase, usando RAM:", e);
    }
  }

  const fallback = Array.from(recentChatAuditsRAM.values()).sort((a, b) => b.timestamp - a.timestamp);
  res.json({ success: true, audits: fallback });
});

// 4. PALABRAS PROHIBIDAS
app.get('/api/banned-words', (req, res) => {
  res.json({ words: Array.from(dynamicBannedWords) });
});

app.post('/api/banned-words', (req, res) => {
  const { word } = req.body;
  if (word && word.trim().length > 1) {
    dynamicBannedWords.add(word.trim().toLowerCase());
  }
  res.json({ success: true, words: Array.from(dynamicBannedWords) });
});

app.post('/api/banned-words/delete', (req, res) => {
  const { word } = req.body;
  if (word) {
    dynamicBannedWords.delete(word.trim().toLowerCase());
  }
  res.json({ success: true, words: Array.from(dynamicBannedWords) });
});

// 5. CONSOLIDADO EN VIVO PARA EL MONITOR
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
        idleSeconds: data.idleSeconds
      });

      opEntry.totalLetters += data.pendingReadLetters;
      if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
      if (data.isAfk) opEntry.isAfkGlobal = true;
      if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
    }
  }

  res.json({
    success: true,
    operators: Array.from(operatorsMap.values())
  });
});

// 6. DASHBOARD HTML EMBEBIDO
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RYR TITAN APEX - LIVE MONITOR & AUDIT</title>
  <style>
    :root {
      --bg-main: #060913;
      --bg-card: #0e1526;
      --bg-card-hover: #151f38;
      --accent-green: #10b981;
      --accent-cyan: #00ffcc;
      --accent-orange: #f59e0b;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-color: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: var(--bg-main); color: var(--text-main); font-family: system-ui, -apple-system, sans-serif; padding: 12px; }
    header { display: flex; justify-content: space-between; align-items: center; background: #0b132b; border: 1px solid var(--border-color); border-left: 4px solid var(--accent-cyan); border-radius: 8px; padding: 10px 16px; margin-bottom: 12px; }
    .brand-title { font-size: 14px; font-weight: 900; letter-spacing: 1.5px; color: var(--accent-cyan); }
    .metrics-bar { display: flex; gap: 8px; align-items: center; }
    .metric-pill { background: #1c2541; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: bold; border: 1px solid #3a506b; display: flex; align-items: center; gap: 6px; }
    .metric-pill.danger { border-color: var(--accent-red); color: var(--accent-red); background: rgba(239, 68, 68, 0.15); animation: pulse 1.5s infinite; }
    .metric-pill.afk-pill { border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168, 85, 247, 0.15); }
    .btn-action { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 11px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-action:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .btn-action.active { border-color: var(--accent-green); color: var(--accent-green); background: rgba(16,185,129,0.1); }
    .filters-bar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .filter-btn { background: #1c2541; color: var(--text-muted); border: 1px solid var(--border-color); padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .filter-btn.active, .filter-btn:hover { background: var(--accent-green); color: #000; border-color: var(--accent-green); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .operator-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; position: relative; transition: 0.2s; }
    .operator-card.in-breach { border-color: var(--accent-red) !important; box-shadow: 0 0 16px rgba(239, 68, 68, 0.4); animation: pulse 1s infinite; }
    .operator-card.is-afk { border-color: var(--accent-purple) !important; box-shadow: 0 0 16px rgba(168, 85, 247, 0.3); }
    .operator-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; margin-bottom: 10px; }
    .operator-name { font-size: 13px; font-weight: 800; color: #fff; }
    .shift-tag { font-size: 10px; background: #1e293b; color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
    .profiles-list { display: flex; flex-direction: column; gap: 8px; }
    .profile-item { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; }
    .profile-item.alert-profile { border-color: var(--accent-red); background: rgba(239, 68, 68, 0.08); }
    .profile-name { font-size: 12px; font-weight: 700; color: var(--accent-cyan); }
    .profile-stats { display: flex; gap: 8px; font-size: 11px; margin-top: 2px; }
    .stat-letters { color: #38bdf8; font-weight: bold; }
    .stat-sla { font-weight: bold; padding: 2px 6px; border-radius: 4px; font-size: 10px; }
    .stat-sla.ok { background: #064e3b; color: #34d399; }
    .stat-sla.breach { background: #7f1d1d; color: #fca5a5; animation: pulse 1s infinite; }
    .stat-sla.afk { background: #581c87; color: #d8b4fe; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 99999; justify-content: center; align-items: center; }
    .modal-content { background: #0e1526; border: 1px solid var(--accent-cyan); border-radius: 10px; width: 850px; max-width: 95%; max-height: 88vh; padding: 20px; display: flex; flex-direction: column; gap: 12px; color: #fff; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 10px; font-weight: 800; color: var(--accent-cyan); }
    .modal-body { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
    .audit-card { background: #060913; border: 1px solid #1e293b; border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .audit-card.flagged { border-color: var(--accent-red); background: rgba(239, 68, 68, 0.05); }
    .audit-header { display: flex; justify-content: space-between; align-items: center; }
    .audit-title { font-size: 12px; font-weight: 800; color: var(--accent-cyan); }
    .audit-flags { display: flex; flex-wrap: wrap; gap: 6px; }
    .flag-badge { font-size: 10px; font-weight: bold; padding: 2px 7px; border-radius: 4px; background: #1c2541; border: 1px solid #3a506b; color: #38bdf8; }
    .flag-badge.danger { border-color: #ef4444; color: #f87171; background: rgba(239, 68, 68, 0.2); }
    .flag-badge.warn { border-color: #f59e0b; color: #fbbf24; background: rgba(245, 158, 11, 0.2); }
    .chat-transcript { background: #0b132b; border: 1px solid #1e293b; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; line-height: 1.5; color: #cbd5e1; }
    .banned-tags-container { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .banned-tag { background: #1c2541; border: 1px solid #ef4444; color: #fca5a5; padding: 4px 8px; border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 6px; }
    .banned-tag span { cursor: pointer; font-weight: bold; color: #fff; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <div class="brand-title">⚡ RYR TITAN APEX - AUDITORÍA & SUPERVISIÓN LIVE</div>
    <div class="metrics-bar">
      <div class="metric-pill">👥 Ops: <span id="total-operators">0</span></div>
      <div class="metric-pill">✉️ Cartas: <span id="total-letters">0</span></div>
      <div id="afk-pill" class="metric-pill afk-pill" style="display:none;">💤 Inactivos: <span id="total-afk">0</span></div>
      <div id="alert-pill" class="metric-pill danger" style="display:none;">🚨 Alertas SLA: <span id="total-alerts">0</span></div>
      <button class="btn-action" onclick="openChatAuditsModal()">📄 Auditoría de Chats (MD)</button>
      <button class="btn-action" onclick="openBannedWordsModal()">🛡️ Palabras Prohibidas</button>
      <button id="btn-sound" class="btn-action" onclick="toggleAudio()">🔇 Sonido: OFF</button>
    </div>
  </header>

  <div class="filters-bar">
    <span style="font-size: 11px; color: var(--text-muted); font-weight: bold;">TURNO:</span>
    <button class="filter-btn active" onclick="setShiftFilter('ALL')">TODOS</button>
    <button class="filter-btn" onclick="setShiftFilter('Mañana')">Mañana</button>
    <button class="filter-btn" onclick="setShiftFilter('Tarde')">Tarde</button>
    <button class="filter-btn" onclick="setShiftFilter('Noche')">Noche</button>
    <button class="filter-btn" onclick="setShiftFilter('Trasnocho')">Trasnocho</button>
  </div>

  <div id="operators-grid" class="grid-operators"></div>

  <div id="modal-chats" class="modal-overlay">
    <div class="modal-content">
      <div class="modal-header">
        <span>📄 CENTRO DE AUDITORÍA DE CONVERSACIONES (SUPABASE PERSISTED)</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-search-audit" oninput="filterAudits()" placeholder="Buscar por operador, perfil o cliente..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
      </div>
      <div class="modal-body" id="chat-audits-list">
        <p style="color:var(--text-muted);">Cargando conversaciones desde Supabase...</p>
      </div>
    </div>
  </div>

  <div id="modal-banned" class="modal-overlay">
    <div class="modal-content" style="width:600px;">
      <div class="modal-header">
        <span>🛡️ FIREWALL EN TIEMPO REAL: PALABRAS PROHIBIDAS</span>
        <button class="btn-action" onclick="closeModals()">✕</button>
      </div>
      <div style="display:flex; gap:8px;">
        <input type="text" id="input-new-word" placeholder="Nueva palabra prohibida..." style="flex:1; padding:8px; background:#060913; border:1px solid #3a506b; color:#fff; border-radius:6px; outline:none; font-size:12px;">
        <button class="btn-action" style="background:#10b981; color:#000;" onclick="addBannedWord()">+ Agregar</button>
      </div>
      <div class="modal-body">
        <div id="banned-words-list" class="banned-tags-container"></div>
      </div>
    </div>
  </div>

  <script>
    let activeFilter = 'ALL';
    let soundEnabled = false;
    let audioCtx = null;
    let globalAuditsCache = [];
    const API_URL = window.location.origin;

    function toggleAudio() {
      soundEnabled = !soundEnabled;
      const btn = document.getElementById('btn-sound');
      if (soundEnabled) {
        btn.innerText = '🔊 Sonido: ON';
        btn.classList.add('active');
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        playBeep(600, 0.1);
      } else {
        btn.innerText = '🔇 Sonido: OFF';
        btn.classList.remove('active');
      }
    }

    function playBeep(freq = 880, duration = 0.2) {
      if (!soundEnabled) return;
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
      } catch (e) {}
    }

    function setShiftFilter(shift) {
      activeFilter = shift;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.innerText.includes(shift) || (shift === 'ALL' && btn.innerText === 'TODOS'));
      });
      fetchLiveTelemetry();
    }

    async function fetchLiveTelemetry() {
      try {
        const res = await fetch(\`\${API_URL}/api/telemetry/live\`);
        const data = await res.json();
        renderDashboard(data.operators || []);
      } catch (err) {}
    }

    function renderDashboard(operatorsList) {
      const grid = document.getElementById('operators-grid');
      grid.innerHTML = '';
      let globalLetters = 0, globalAlerts = 0, globalAfk = 0;

      const filtered = operatorsList.filter(op => activeFilter === 'ALL' || op.shift === activeFilter);

      filtered.forEach(op => {
        let opHasBreach = op.hasExpiredSlaGlobal;
        let opIsAfk = op.isAfkGlobal;
        let profilesHtml = '';
        globalLetters += op.totalLetters;
        if (opIsAfk) globalAfk++;

        op.profiles.forEach(p => {
          if (p.hasExpiredSla) globalAlerts++;
          let slaClass = p.hasExpiredSla ? 'breach' : (p.isAfk ? 'afk' : 'ok');
          let slaText = p.hasExpiredSla ? '🚨 +2 MIN' : (p.isAfk ? \`💤 \${Math.floor(p.idleSeconds/60)}m AFK\` : '⏱️ AL DÍA');

          profilesHtml += \`
            <div class="profile-item \${p.hasExpiredSla ? 'alert-profile' : ''}">
              <div>
                <span class="profile-name">🎯 \${p.profileName}</span>
                <div class="profile-stats">
                  <span class="stat-letters">✉️ \${p.pendingReadLetters || 0} cartas</span>
                  \${p.unansweredChatsCount > 0 ? \`<span style="color:#f59e0b;">💬 \${p.unansweredChatsCount}</span>\` : ''}
                </div>
              </div>
              <span class="stat-sla \${slaClass}">\${slaText}</span>
            </div>\`;
        });

        const card = document.createElement('div');
        card.className = \`operator-card \${opHasBreach ? 'in-breach' : ''} \${opIsAfk ? 'is-afk' : ''}\`;
        card.innerHTML = \`
          <div class="operator-header">
            <span class="operator-name">👤 \${op.operatorName} (\${op.profiles.length} Perfiles)</span>
            <span class="shift-tag">\${op.shift}</span>
          </div>
          <div class="profiles-list">\${profilesHtml}</div>
          <div style="font-size:9px; color:var(--text-muted); margin-top:6px; text-align:right;">Activo hace \${Math.floor((Date.now() - op.lastSeen) / 1000)}s</div>\`;
        grid.appendChild(card);
      });

      document.getElementById('total-operators').innerText = filtered.length;
      document.getElementById('total-letters').innerText = globalLetters;

      const alertPill = document.getElementById('alert-pill');
      if (globalAlerts > 0) {
        alertPill.style.display = 'flex';
        document.getElementById('total-alerts').innerText = globalAlerts;
        playBeep(880, 0.3);
      } else {
        alertPill.style.display = 'none';
      }

      const afkPill = document.getElementById('afk-pill');
      if (globalAfk > 0) {
        afkPill.style.display = 'flex';
        document.getElementById('total-afk').innerText = globalAfk;
      } else {
        afkPill.style.display = 'none';
      }
    }

    async function openChatAuditsModal() {
      document.getElementById('modal-chats').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/chats/audits\`);
      const data = await res.json();
      globalAuditsCache = data.audits || [];
      renderAuditsList(globalAuditsCache);
    }

    function renderAuditsList(audits) {
      const container = document.getElementById('chat-audits-list');
      if (audits.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);">No hay conversaciones en Supabase aún. Haz clic en "⚡ Extraer Chat" en Talkytimes.</p>';
        return;
      }

      container.innerHTML = audits.map(a => {
        const flagHtml = a.flags.map(f => {
          let c = 'flag-badge';
          if (f.startsWith('🚨') || f.startsWith('🛑')) c += ' danger';
          else if (f.startsWith('💡') || f.startsWith('⚠️')) c += ' warn';
          return \`<span class="\${c}">\${f}</span>\`;
        }).join('');

        const blob = new Blob([a.markdown], { type: 'text/markdown' });
        const downloadUrl = URL.createObjectURL(blob);

        return \`
          <div class="audit-card \${a.hasBreach ? 'flagged' : ''}">
            <div class="audit-header">
              <span class="audit-title">👤 Op: \${a.operator} | 🎯 Perfil: \${a.profile} | 💬 Cliente: \${a.clientName} (\${a.clientId})</span>
              <a href="\${downloadUrl}" download="chat_\${a.profile}_\${a.clientId}.md" class="btn-action" style="text-decoration:none;">📥 Descargar .MD</a>
            </div>
            <div class="audit-flags">\${flagHtml}</div>
            <div class="chat-transcript">\${a.markdown}</div>
          </div>
        \`;
      }).join('');
    }

    function filterAudits() {
      const query = document.getElementById('input-search-audit').value.toLowerCase();
      const filtered = globalAuditsCache.filter(a => 
        a.operator.toLowerCase().includes(query) ||
        a.profile.toLowerCase().includes(query) ||
        a.clientName.toLowerCase().includes(query) ||
        a.clientId.toLowerCase().includes(query) ||
        a.flags.some(f => f.toLowerCase().includes(query))
      );
      renderAuditsList(filtered);
    }

    async function openBannedWordsModal() {
      document.getElementById('modal-banned').style.display = 'flex';
      const res = await fetch(\`\${API_URL}/api/banned-words\`);
      const data = await res.json();
      renderBannedTags(data.words || []);
    }

    function renderBannedTags(words) {
      const container = document.getElementById('banned-words-list');
      container.innerHTML = words.map(w => \`
        <div class="banned-tag">
          <span>\${w}</span>
          <span onclick="deleteBannedWord('\${w}')">✕</span>
        </div>
      \`).join('');
    }

    async function addBannedWord() {
      const input = document.getElementById('input-new-word');
      const word = input.value.trim();
      if (!word) return;
      const res = await fetch(\`\${API_URL}/api/banned-words\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
      });
      const data = await res.json();
      input.value = '';
      renderBannedTags(data.words || []);
    }

    async function deleteBannedWord(word) {
      const res = await fetch(\`\${API_URL}/api/banned-words/delete\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word })
      });
      const data = await res.json();
      renderBannedTags(data.words || []);
    }

    function closeModals() {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    }

    setInterval(fetchLiveTelemetry, 2000);
    fetchLiveTelemetry();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor.html', (req, res) => res.send(DASHBOARD_HTML));

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND conectado a Supabase en puerto ${PORT}`);
});
