const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Memoria centralizada de telemetría
const liveTelemetryMap = new Map();

// CATÁLOGO MAESTRO REAL DE LA AGENCIA (46 PERFILES)
const agencyProfiles = [
  { id: '88243516', name: 'RICARDO' },
  { id: '95956014', name: 'PABLO' },
  { id: '91360720', name: 'SANDRA MARIA' },
  { id: '91733663', name: 'DANIEL 68' },
  { id: '79679899', name: 'NORBERTO' },
  { id: '99766806', name: 'EDUARDO' },
  { id: '168486464', name: 'GUSTAVO' },
  { id: '108018336', name: 'LUCAS' },
  { id: '103289167', name: 'LUIS DAROSA' },
  { id: '118179794', name: 'HORACIO' },
  { id: '157112125', name: 'LUIZ' },
  { id: '103291980', name: 'ARMANDO' },
  { id: '120720195', name: 'MARCOS' },
  { id: '139247498', name: 'DAMIAN' },
  { id: '120275229', name: 'GERMAN' },
  { id: '130338853', name: 'IVALDO' },
  { id: '130431310', name: 'RAFAEL' },
  { id: '98389135', name: 'RAUL' },
  { id: '139245989', name: 'ALFREDO' },
  { id: '156881990', name: 'RALPH' },
  { id: '137163229', name: 'SEBASTIAN' },
  { id: '143017065', name: 'MARIO' },
  { id: '138130329', name: 'AGUSTIN' },
  { id: '143014129', name: 'RENEE' },
  { id: '95955130', name: 'HECTOR' },
  { id: '145211163', name: 'FERMIN' },
  { id: '145844971', name: 'RODRIGO' },
  { id: '170740935', name: 'ROBERTO' },
  { id: '130422416', name: 'RAONI' },
  { id: '160352260', name: 'JUVENAL' },
  { id: '157067734', name: 'VALDEMIR' },
  { id: '153039388', name: 'AGUSTIN FERNANDO' },
  { id: '109551682', name: 'RENATO' },
  { id: '98540781', name: 'LEANDRO' },
  { id: '167493871', name: 'HUMBERTO' },
  { id: '158644203', name: 'SERGIO' },
  { id: '174069335', name: 'FEDERICO' },
  { id: '93461947', name: 'MARIANO' },
  { id: '166575347', name: 'MAX' },
  { id: '101245945', name: 'PABLO' },
  { id: '167273716', name: 'ARIEL HERNAN' },
  { id: '113579174', name: 'RONALDO' },
  { id: '145839775', name: 'BRUNO' },
  { id: '113752797', name: 'ROMARIO' },
  { id: '167279664', name: 'JOSE ROBERTO' },
  { id: '171638277', name: 'RONALT' }
];

// 1. ENDPOINT: RECIBIR LATIDOS DE LA EXTENSIÓN
app.post('/api/telemetry', (req, res) => {
  const {
    operator,
    shift,
    profile,
    profileId,
    pendingReadLetters,
    unansweredChatsCount,
    hasExpiredSla,
    isAfk,
    idleSeconds,
    status
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

// 2. ENDPOINT: DATOS EN VIVO PARA EL MONITOR
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();

  for (const [key, data] of liveTelemetryMap.entries()) {
    if (now - data.lastSeen > 35000) {
      liveTelemetryMap.delete(key);
    } else {
      if (!operatorsMap.has(data.operatorName)) {
        operatorsMap.set(data.operatorName, {
          operatorName: data.operatorName,
          shift: data.shift,
          lastSeen: data.lastSeen,
          isAfkGlobal: false,
          hasExpiredSlaGlobal: false,
          totalLetters: 0,
          profiles: []
        });
      }

      const opEntry = operatorsMap.get(data.operatorName);
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

// 3. ENDPOINT: OBTENER PERFILES REALES DE AGENCIA
app.get('/api/perfiles', (req, res) => {
  res.json({
    success: true,
    perfiles: agencyProfiles
  });
});

// 4. PALABRAS PROHIBIDAS
app.get('/api/banned-words', (req, res) => {
  res.json({
    words: ['whatsapp', 'skype', 'email', 'correo', 'teléfono', 'prometo', 'promesa', 'número', 'banco', 'tarjeta', 'instagram', 'telegram']
  });
});

// 5. DASHBOARD COMPLETO EMBEBIDO (IFRAME)
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RYR TITAN APEX - LIVE MONITOR</title>
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
    .metrics-bar { display: flex; gap: 10px; align-items: center; }
    .metric-pill { background: #1c2541; padding: 5px 12px; border-radius: 6px; font-size: 11px; font-weight: bold; border: 1px solid #3a506b; display: flex; align-items: center; gap: 6px; }
    .metric-pill.danger { border-color: var(--accent-red); color: var(--accent-red); background: rgba(239, 68, 68, 0.15); animation: pulse 1.5s infinite; }
    .metric-pill.afk-pill { border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(168, 85, 247, 0.15); }
    .audio-btn { background: #1e293b; color: #fff; border: 1px solid #3a506b; padding: 5px 10px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .audio-btn.active { border-color: var(--accent-green); color: var(--accent-green); }
    .filters-bar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .filter-btn { background: #1c2541; color: var(--text-muted); border: 1px solid var(--border-color); padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer; }
    .filter-btn.active, .filter-btn:hover { background: var(--accent-green); color: #000; border-color: var(--accent-green); }
    .grid-operators { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
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
    .profile-stats { display: flex; gap: 8px; font-size: 11px; }
    .stat-letters { color: #38bdf8; font-weight: bold; }
    .stat-sla { font-weight: bold; padding: 2px 6px; border-radius: 4px; font-size: 10px; }
    .stat-sla.ok { background: #064e3b; color: #34d399; }
    .stat-sla.breach { background: #7f1d1d; color: #fca5a5; animation: pulse 1s infinite; }
    .stat-sla.afk { background: #581c87; color: #d8b4fe; }
    .last-seen { font-size: 9px; color: var(--text-muted); margin-top: 6px; text-align: right; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <div class="brand-title">⚡ RYR TITAN APEX - SUPERVISIÓN LIVE</div>
    <div class="metrics-bar">
      <div class="metric-pill">👥 Operadores: <span id="total-operators">0</span></div>
      <div class="metric-pill">✉️ Cartas: <span id="total-letters">0</span></div>
      <div id="afk-pill" class="metric-pill afk-pill" style="display:none;">💤 Inactivos (+5m): <span id="total-afk">0</span></div>
      <div id="alert-pill" class="metric-pill danger" style="display:none;">🚨 Alertas SLA (+2m): <span id="total-alerts">0</span></div>
      <button id="btn-sound" class="audio-btn" onclick="toggleAudio()">🔇 Sonido: OFF</button>
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
  <script>
    let activeFilter = 'ALL';
    let soundEnabled = false;
    let audioCtx = null;
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
              <div class="profile-info">
                <span class="profile-name">🎯 \${p.profileName}</span>
                <span class="profile-stats">
                  <span class="stat-letters">✉️ \${p.pendingReadLetters || 0} cartas</span>
                  \${p.unansweredChatsCount > 0 ? \`<span style="color:#f59e0b;">💬 \${p.unansweredChatsCount}</span>\` : ''}
                </span>
              </div>
              <span class="stat-sla \${slaClass}">\${slaText}</span>
            </div>\`;
        });

        const card = document.createElement('div');
        card.className = \`operator-card \${opHasBreach ? 'in-breach' : ''} \${opIsAfk ? 'is-afk' : ''}\`;
        card.innerHTML = \`
          <div class="operator-header">
            <span class="operator-name">👤 \${op.operatorName}</span>
            <span class="shift-tag">\${op.shift}</span>
          </div>
          <div class="profiles-list">\${profilesHtml}</div>
          <div class="last-seen">Activo hace \${Math.floor((Date.now() - op.lastSeen) / 1000)}s</div>\`;
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

    setInterval(fetchLiveTelemetry, 2000);
    fetchLiveTelemetry();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor', (req, res) => res.send(DASHBOARD_HTML));
app.get('/monitor.html', (req, res) => res.send(DASHBOARD_HTML));

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND activo en puerto ${PORT}`);
});
