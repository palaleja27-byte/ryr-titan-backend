const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Memoria centralizada de telemetría en tiempo real
// Key: `${operatorName.toLowerCase()}_${profileName.toLowerCase()}`
const liveTelemetryMap = new Map();

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

  // Si el operador hizo clic en "Desconectar"
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

// 2. ENDPOINT: CONSOLIDADO EN TIEMPO REAL PARA EL MONITOR IFRAME
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();

  // Limpiar sesiones inactivas (más de 35s sin reporte)
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

// 3. PALABRAS PROHIBIDAS
app.get('/api/banned-words', (req, res) => {
  res.json({
    words: ['whatsapp', 'skype', 'email', 'correo', 'teléfono', 'prometo', 'promesa', 'número', 'banco', 'tarjeta', 'instagram', 'telegram', 'números']
  });
});

// 4. PERFILES PARA EL POPUP
app.get('/api/perfiles', (req, res) => {
  res.json({
    success: true,
    perfiles: [
      { id: '118179794', name: 'HORACIO' },
      { id: '118179795', name: 'BLONDEBABY' },
      { id: '118179796', name: 'MARIPOSA' },
      { id: '118179797', name: 'ELENA' },
      { id: '118179798', name: 'HELENA' },
      { id: '118179799', name: 'DUDA' }
    ]
  });
});

app.get('/monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND V3.0 escuchando en puerto ${PORT}`);
});
