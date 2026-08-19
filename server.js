const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Memoria centralizada de telemetría en tiempo real
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

// 2. ENDPOINT: CONSOLIDADO EN VIVO PARA EL MONITOR
app.get('/api/telemetry/live', (req, res) => {
  const now = Date.now();
  const operatorsMap = new Map();

  for (const [key, data] of liveTelemetryMap.entries()) {
    // Si pasan más de 35s sin reporte, se considera desconectado
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
    words: ['whatsapp', 'skype', 'email', 'correo', 'teléfono', 'prometo', 'promesa', 'número', 'banco', 'tarjeta', 'instagram', 'telegram']
  });
});

// 4. PERFILES
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

// 5. MANEJADOR BLINDADO PARA SERVIR EL DASHBOARD
const serveDashboard = (req, res) => {
  const filePath = path.join(__dirname, 'monitor.html');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  // Plantilla HTML de respaldo embebida
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>RYR TITAN APEX - MONITOR</title>
      <style>
        body { background: #060913; color: #fff; font-family: monospace; padding: 20px; }
        .box { border: 1px solid #10b981; padding: 15px; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>⚡ RYR TITAN APEX - SERVICIO ACTIVO</h2>
        <p>El backend está en línea. Sube monitor.html a GitHub para la interfaz completa.</p>
      </div>
    </body>
    </html>
  `);
};

// Rutas explícitas para que todas funcionen sin error
app.get('/', serveDashboard);
app.get('/monitor', serveDashboard);
app.get('/monitor.html', serveDashboard);

app.listen(PORT, () => {
  console.log(`🚀 RYR TITAN BACKEND activo en puerto ${PORT}`);
});
