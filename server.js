const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Memoria centralizada de telemetría (Volátil para máxima velocidad)
const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();
const operatorFinesRAM = new Map();

// --- RUTAS DE LA API ---

// 1. Recibir datos de la extensión (Heartbeat)
app.post('/api/telemetry', (req, res) => {
  const data = req.body;
  if (!data.operator || !data.profile) return res.status(400).json({ error: 'Incompleto' });

  // Llave única por operador y perfil
  const sessionKey = `${data.operator.toLowerCase().trim()}_${data.profile.toLowerCase().trim()}`;
  
  if (data.status === 'OFFLINE') {
    liveTelemetryMap.delete(sessionKey);
    return res.json({ success: true });
  }

  // Guardar con marca de tiempo actual
  liveTelemetryMap.set(sessionKey, {
    ...data,
    lastSeen: Date.now(),
    pendingReadLetters: parseInt(data.pendingReadLetters || 0, 10),
    idleSeconds: parseInt(data.idleSeconds || 0, 10)
  });

  res.json({ success: true });
});

// 2. Enviar datos consolidados al Monitor (IFRAME)
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();

  for (const [key, data] of liveTelemetryMap.entries()) {
    // Si no ha enviado señal en 40 segundos, lo borramos (Desconectado)
    if (now - data.lastSeen > 40000) {
      liveTelemetryMap.delete(key);
      continue;
    }

    const opKey = data.operator.toLowerCase().trim();
    if (!operatorsMap.has(opKey)) {
      operatorsMap.set(opKey, {
        operatorName: data.operator,
        shift: data.shift || 'Tarde',
        lastSeen: data.lastSeen,
        hasExpiredSlaGlobal: false,
        totalLetters: 0,
        profiles: []
      });
    }

    const opEntry = operatorsMap.get(opKey);
    opEntry.profiles.push(data);
    opEntry.totalLetters += data.pendingReadLetters;
    if (data.hasExpiredSla) opEntry.hasExpiredSlaGlobal = true;
    if (data.lastSeen > opEntry.lastSeen) opEntry.lastSeen = data.lastSeen;
  }

  res.json({ success: true, operators: Array.from(operatorsMap.values()) });
});

// 3. Multas e Historial
app.post('/api/fines/register', (req, res) => {
  const fineId = `FINE_${Date.now()}`;
  operatorFinesRAM.set(fineId, { ...req.body, created_at: new Date().toISOString() });
  res.json({ success: true });
});

app.get('/api/fines', (req, res) => res.json({ success: true, fines: Array.from(operatorFinesRAM.values()).reverse() }));

// 4. Auditoría de Chats
app.post('/api/chats/audit-deep', (req, res) => {
  recentChatAuditsRAM.set(`${req.body.profile}_${req.body.clientId}`, { ...req.body, timestamp: Date.now() });
  res.json({ success: true });
});

app.get('/api/chats/audits', (req, res) => res.json({ success: true, audits: Array.from(recentChatAuditsRAM.values()).reverse() }));

// 5. Palabras Prohibidas
app.get('/api/banned-words', (req, res) => res.json({ words: ['whatsapp', 'skype', 'email', 'instagram', 'telegram', 'facebook', 'prometo'] }));

// --- SERVIR MONITOR HTML ---
// Importante: Definir monitor.html al final para no interferir con la API
app.get(['/', '/monitor', '/monitor.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.listen(PORT, () => console.log(`🚀 RYR TITAN ENGINE V39 activo en puerto ${PORT}`));
