const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

let bannedWords = ['whatsapp', 'skype', 'email', 'correo', 'teléfono', 'prometo', 'promesa', 'número', 'banco', 'tarjeta'];
let activeOperators = {}; 

// Ruta para obtener palabras prohibidas
app.get('/api/banned-words', (req, res) => {
    res.json({ words: bannedWords });
});

// Ruta de telemetría (la extensión llama a esto)
app.post('/api/telemetry', (req, res) => {
    const data = req.body;
    if (data && data.operator) {
        const key = `${data.operator}-${data.profile}`;
        activeOperators[key] = {
            ...data,
            lastSeen: Date.now()
        };
    }
    res.status(200).send('OK');
});

// Ruta para el Panel de Monitoreo (el iframe llama a esto)
app.get('/api/operators', (req, res) => {
    const now = Date.now();
    const activeList = [];
    for (const key in activeOperators) {
        if (now - activeOperators[key].lastSeen < 20000) {
            activeList.push(activeOperators[key]);
        } else {
            delete activeOperators[key];
        }
    }
    res.json({ operators: activeList });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor RYR TITAN operativo en ${PORT}`));
