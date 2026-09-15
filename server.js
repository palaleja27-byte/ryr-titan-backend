
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const liveTelemetryMap = new Map();

// 1. ENDPOINT: RECIBIR TELEMETRÍA (ESTABLE)
app.post('/api/telemetry', (req, res) => {
  const { operator, shift, profile, pendingReadLetters, unansweredChatsCount, hasExpiredSla, isAfk, status } = req.body;

  if (!operator || !profile) return res.status(400).send();

  const key = `${operator}_${profile}`.toLowerCase();

  if (status === 'OFFLINE') {
    liveTelemetryMap.delete(key);
    return res.json({ success: true });
  }

  liveTelemetryMap.set(key, {
    operatorName: operator,
    shift: shift || 'Tarde',
    profileName: profile,
    pendingReadLetters: pendingReadLetters || 0,
    hasExpiredSla: !!hasExpiredSla,
    isAfk: !!isAfk,
    lastSeen: Date.now()
  });

  res.json({ success: true });
});

// 2. ENDPOINT: DATOS PARA EL MONITOR (ESTABLE)
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operators = [];

  for (const [key, data] of liveTelemetryMap.entries()) {
    if (now - data.lastSeen > 35000) {
      liveTelemetryMap.delete(key);
    } else {
      operators.push(data);
    }
  }
  res.json({ success: true, operators });
});

// 3. PALABRAS PROHIBIDAS (ESTABLE)
app.get('/api/banned-words', (req, res) => {
  res.json({ words: ['whatsapp', 'skype', 'email', 'correo', 'teléfono', 'número', 'instagram', 'telegram', 'prometo'] });
});

// SERVIR EL MONITOR
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.listen(PORT, () => console.log(`🚀 Servidor Estable en puerto ${PORT}`));
