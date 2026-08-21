/**
 * ============================================================================
 * RYR TITAN APEX - BACKEND CORE & CO-PILOTO ANALÍTICO IA
 * ============================================================================
 * Stack: Node.js, Express, Groq SDK, Supabase
 */

// 1. CARGA SEGURA DE MÓDULOS (A prueba de fallos)
let dotenv, createClient, Groq;

try { require('dotenv').config(); } catch (e) {}

try {
    const supabasePkg = require('@supabase/supabase-js');
    createClient = supabasePkg.createClient;
} catch (e) {
    console.warn('⚠️ [@supabase/supabase-js]: No instalado aún en node_modules.');
}

try {
    Groq = require('groq-sdk');
} catch (e) {
    console.warn('⚠️ [groq-sdk]: No instalado aún en node_modules.');
}

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// 2. INICIALIZACIÓN DE SERVICIOS EXTERNOS
// ==========================================

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (createClient && SUPABASE_URL && SUPABASE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('✅ [Supabase]: Conexión establecida.');
    } catch (err) {
        console.warn('⚠️ [Supabase Warn]:', err.message);
    }
}

// Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groq = null;
if (Groq && GROQ_API_KEY) {
    try {
        groq = new Groq({ apiKey: GROQ_API_KEY });
        console.log('✅ [Groq]: SDK inicializado.');
    } catch (err) {
        console.warn('⚠️ [Groq Warn]:', err.message);
    }
}

// ==========================================
// 3. AUTO-DISCOVERY DE MODELOS GROQ
// ==========================================
let cachedGroqModel = null;
let lastModelCheck = 0;

async function autoDiscoverGroqModel() {
    const now = Date.now();
    if (cachedGroqModel && (now - lastModelCheck < 3600000)) {
        return cachedGroqModel;
    }

    const priorityModels = [
        'llama-3.3-70b-versatile',
        'llama-3.1-70b-versatile',
        'llama-3.1-8b-instant',
        'mixtral-8x7b-32768',
        'gemma2-9b-it'
    ];

    if (!groq) {
        cachedGroqModel = 'llama-3.1-8b-instant';
        return cachedGroqModel;
    }

    try {
        const modelList = await groq.models.list();
        const activeModels = modelList.data.map(m => m.id);

        for (const preferred of priorityModels) {
            if (activeModels.includes(preferred)) {
                cachedGroqModel = preferred;
                lastModelCheck = now;
                console.log(`🤖 [Groq Model Auto-Selected]: ${cachedGroqModel}`);
                return cachedGroqModel;
            }
        }

        if (activeModels.length > 0) {
            cachedGroqModel = activeModels[0];
            lastModelCheck = now;
            return cachedGroqModel;
        }
    } catch (err) {
        console.warn('⚠️ [Groq Discovery Fallback]:', err.message);
    }

    cachedGroqModel = 'llama-3.1-8b-instant';
    return cachedGroqModel;
}

// ==========================================
// 4. MEMORIA VOLÁTIL / TIEMPO REAL
// ==========================================
const memoryStore = {
    operators: {},
    chatMarkdownLogs: {},
    alerts: [],
    fines: [],
    metrics: {
        totalAudits: 0,
        totalFinesCOP: 0,
        totalAlerts: 0
    }
};

const FINE_VALUE_COP = 10000;

// Reglas de Travel Misleading
const FORBIDDEN_TRAVEL_PATTERNS = [
    /voy a ir a verte/i,
    /te ir[eé] a visitar/i,
    /vamos a vernos pronto/i,
    /comprar[eé] el pasaje/i,
    /viajar[eé] a tu pa[ií]s/i,
    /meet in person soon/i,
    /buy (a )?ticket to see you/i,
    /i will visit you/i,
    /i am coming to your country/i
];

function analyzeTravelMisleadingHeuristic(text) {
    if (!text || typeof text !== 'string') return { detected: false };
    for (const pattern of FORBIDDEN_TRAVEL_PATTERNS) {
        if (pattern.test(text)) {
            return {
                detected: true,
                type: 'TRAVEL_MISLEADING',
                matched: pattern.toString(),
                severity: 'CRITICAL',
                fineAmount: FINE_VALUE_COP
            };
        }
    }
    return { detected: false };
}

// ==========================================
// 5. RUTAS & CONTROLADORES
// ==========================================

app.get('/', (req, res) => {
    res.json({
        service: 'RYR Titan Apex Core',
        status: 'ONLINE',
        supabase: supabase ? 'CONNECTED' : 'DISCONNECTED',
        groq: groq ? 'CONNECTED' : 'DISCONNECTED',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/telemetry', (req, res) => {
    const { operatorId, operatorName, activeChatId, chatOpenTime, isTyping } = req.body;
    if (!operatorId) return res.status(400).json({ error: 'operatorId requerido' });

    const now = Date.now();
    memoryStore.operators[operatorId] = {
        operatorId,
        operatorName: operatorName || `Operador_${operatorId}`,
        activeChatId: activeChatId || null,
        chatOpenTime: chatOpenTime || now,
        isTyping: !!isTyping,
        lastSeen: now
    };

    res.json({ success: true, timestamp: now });
});

app.post('/api/audit', async (req, res) => {
    try {
        const {
            operatorId,
            operatorName,
            clientId,
            clientName,
            messageText,
            sender,
            timestamp,
            chatMarkdownFull
        } = req.body;

        if (!clientId) return res.status(400).json({ success: false, error: 'clientId requerido' });

        memoryStore.metrics.totalAudits++;

        if (chatMarkdownFull) {
            memoryStore.chatMarkdownLogs[clientId] = chatMarkdownFull;
        } else if (messageText) {
            const formatted = `[${timestamp || new Date().toLocaleTimeString()}] ${sender || 'Desconocido'}: ${messageText}\n`;
            memoryStore.chatMarkdownLogs[clientId] = (memoryStore.chatMarkdownLogs[clientId] || '') + formatted;
        }

        let infraction = null;
        if (sender && (sender.toLowerCase().includes('operador') || sender.toLowerCase().includes('yo') || sender.toLowerCase().includes('agent'))) {
            const heuristic = analyzeTravelMisleadingHeuristic(messageText);
            if (heuristic.detected) {
                infraction = {
                    operatorId: operatorId || 'N/A',
                    operatorName: operatorName || 'Operador',
                    clientId,
                    clientName: clientName || `Cliente_${clientId}`,
                    reason: 'Infracción por Promesa de Viaje / Encuentro (Travel Misleading)',
                    evidence: messageText,
                    fineAmount: FINE_VALUE_COP,
                    timestamp: new Date().toISOString()
                };

                memoryStore.fines.unshift(infraction);
                memoryStore.alerts.unshift({
                    id: Date.now(),
                    type: 'TRAVEL_MISLEADING',
                    severity: 'HIGH',
                    message: `Multa aplicada a ${operatorName || 'Operador'}: $${FINE_VALUE_COP.toLocaleString('es-CO')} COP`,
                    details: infraction,
                    timestamp: new Date().toISOString()
                });

                memoryStore.metrics.totalFinesCOP += FINE_VALUE_COP;
                memoryStore.metrics.totalAlerts++;

                if (supabase) {
                    supabase.from('operator_fines').insert([{
                        operator_id: operatorId,
                        operator_name: operatorName,
                        client_id: clientId,
                        reason: infraction.reason,
                        evidence: messageText,
                        fine_amount: FINE_VALUE_COP
                    }]).then(({ error }) => {
                        if (error) console.error('❌ [Supabase Fines Error]:', error.message);
                    });
                }
            }
        }

        if (supabase && (chatMarkdownFull || messageText)) {
            supabase.from('chat_audits').upsert([{
                client_id: String(clientId),
                client_name: clientName || null,
                operator_id: operatorId || null,
                chat_markdown: memoryStore.chatMarkdownLogs[clientId],
                last_updated: new Date().toISOString()
            }], { onConflict: 'client_id' }).then(({ error }) => {
                if (error) console.error('❌ [Supabase Sync Error]:', error.message);
            });
        }

        return res.json({
            success: true,
            infractionDetected: !!infraction,
            infractionDetails: infraction
        });

    } catch (err) {
        console.error('❌ [Audit Error]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// CO-PILOTO ANALÍTICO IA (ESTILO CHATGPT / SIN ROLEPLAY)
app.post('/api/intelligence/query', async (req, res) => {
    try {
        const { clientId, query, clientData, operatorName } = req.body;

        if (!clientId || !query) {
            return res.status(400).json({ success: false, error: 'clientId y query son requeridos.' });
        }

        let fullChatHistory = memoryStore.chatMarkdownLogs[clientId] || '';

        if (!fullChatHistory && supabase) {
            const { data } = await supabase
                .from('chat_audits')
                .select('chat_markdown')
                .eq('client_id', String(clientId))
                .order('last_updated', { ascending: false })
                .limit(1);

            if (data && data.length > 0) {
                fullChatHistory = data[0].chat_markdown;
                memoryStore.chatMarkdownLogs[clientId] = fullChatHistory;
            }
        }

        const clientContext = `
================ INFORMACIÓN DEL CLIENTE (ID: ${clientId}) ================
- Nombre / Perfil: ${clientData?.name || clientData?.userName || 'No especificado'}
- Ubicación: ${clientData?.location || 'No especificada'}
- Edad / Nacimiento: ${clientData?.age || clientData?.birthdate || 'No especificada'}
- Estado Civil: ${clientData?.relationship || 'No especificado'}
- Notas previas: ${clientData?.interests || 'No especificados'}

================ HISTORIAL DE CONVERSACIONES REALES ================
${fullChatHistory ? fullChatHistory : 'No hay mensajes previos registrados para este cliente.'}
`;

        const systemPrompt = `
Eres el **Analista de Inteligencia y Co-Piloto Estratégico RYR Titan Apex**.
Tu rol es asistir a un OPERADOR HUMANO resolviendo dudas puntuales, analizando al cliente y brindando soporte estratégico.

🚨 REGLAS ESTRICTAS:
1. **PROHIBIDO EL ROLEPLAY / SIMULAR CHATS**: NUNCA inventes conversaciones ficticias como "Operador: ..." o "${clientData?.name || 'Cliente'}: ...". Eres un asesor analítico que le responde directamente al operador.
2. **RAZONAMIENTO DIRECTO (ESTILO CHATGPT)**:
   - Si preguntan si tiene hijos, revisa el historial y responde con hechos (ej: "No tiene hijos humanos. Mencionó que cuida a su madre y tiene 2 gatos a los que trata como sus hijos.").
   - Si piden una sugerencia de mensaje, redacta una propuesta atractiva con datos reales del chat sin violar la norma de Travel Misleading.
3. **CERO PLANTILLAS**: Respuestas fundamentadas y directas.
4. **HONESTIDAD**: Si no se encuentra el dato en el historial, acláralo expresamente.
5. **IDIOMA**: Español profesional y conciso.
`;

        if (!groq) {
            return res.json({
                success: true,
                reply: 'El módulo Groq SDK no está configurado o inicializado en el servidor.'
            });
        }

        const groqModel = await autoDiscoverGroqModel();

        const completion = await groq.chat.completions.create({
            model: groqModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${clientContext}\n\nPREGUNTA DEL OPERADOR (${operatorName || 'Operador'}): "${query}"\n\nResponde directamente como consultor analítico:` }
            ],
            temperature: 0.2,
            max_tokens: 700
        });

        const reply = completion.choices[0]?.message?.content || 'No se pudo generar una respuesta analítica.';

        return res.json({
            success: true,
            modelUsed: groqModel,
            reply: reply.trim()
        });

    } catch (err) {
        console.error('❌ [Intelligence Query Error]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// DASHBOARD
app.get('/api/dashboard-data', (req, res) => {
    const now = Date.now();
    const activeOperators = Object.values(memoryStore.operators).filter(op => (now - op.lastSeen) < 120000);
    res.json({
        metrics: memoryStore.metrics,
        activeOperatorsCount: activeOperators.length,
        operators: activeOperators,
        fines: memoryStore.fines.slice(0, 50),
        alerts: memoryStore.alerts.slice(0, 50)
    });
});

app.get('/dashboard', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>RYR Titan Apex | Control Center</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
        body { background: #0f111a; color: #e2e8f0; padding: 24px; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
        .header h1 { font-size: 24px; color: #a855f7; }
        .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .card-stat { background: #181b2a; border: 1px solid #232942; border-radius: 12px; padding: 20px; }
        .card-stat .title { font-size: 13px; color: #94a3b8; text-transform: uppercase; font-weight: bold; }
        .card-stat .value { font-size: 28px; font-weight: bold; margin-top: 8px; color: #f8fafc; }
        .card-stat .value.danger { color: #f43f5e; }
        .card-stat .value.success { color: #10b981; }
        .main-content { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        .panel { background: #181b2a; border: 1px solid #232942; border-radius: 12px; padding: 20px; }
        .panel h2 { font-size: 16px; margin-bottom: 16px; color: #cbd5e1; border-bottom: 1px solid #232942; padding-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #1e293b; }
        th { color: #94a3b8; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; }
        .badge-danger { background: rgba(244, 63, 94, 0.15); color: #f43f5e; }
        .badge-active { background: rgba(16, 185, 129, 0.15); color: #10b981; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛡️ RYR TITAN APEX <span>• Live Control Monitor</span></h1>
        <div style="color: #10b981;">● SERVICIO ACTIVO</div>
    </div>
    <div class="grid-stats">
        <div class="card-stat"><div class="title">Operadores Activos</div><div class="value success" id="val-operators">0</div></div>
        <div class="card-stat"><div class="title">Auditorías Realizadas</div><div class="value" id="val-audits">0</div></div>
        <div class="card-stat"><div class="title">Total Multas (COP)</div><div class="value danger" id="val-fines">$0</div></div>
        <div class="card-stat"><div class="title">Alertas Críticas</div><div class="value danger" id="val-alerts">0</div></div>
    </div>
    <div class="main-content">
        <div class="panel">
            <h2>👥 Telemetría de Operadores en Vivo</h2>
            <table>
                <thead><tr><th>Operador</th><th>Chat</th><th>Estado</th></tr></thead>
                <tbody id="tbl-operators"><tr><td colspan="3" style="text-align:center; color:#64748b;">Esperando datos...</td></tr></tbody>
            </table>
        </div>
        <div class="panel">
            <h2>🚨 Registro de Multas ($10.000 COP)</h2>
            <table>
                <thead><tr><th>Operador</th><th>Causa</th><th>Monto</th></tr></thead>
                <tbody id="tbl-fines"><tr><td colspan="3" style="text-align:center; color:#64748b;">Sin infracciones.</td></tr></tbody>
            </table>
        </div>
    </div>
    <script>
        async function updateDashboard() {
            try {
                const res = await fetch('/api/dashboard-data');
                const data = await res.json();
                document.getElementById('val-operators').innerText = data.activeOperatorsCount || 0;
                document.getElementById('val-audits').innerText = data.metrics.totalAudits || 0;
                document.getElementById('val-fines').innerText = '$' + (data.metrics.totalFinesCOP || 0).toLocaleString('es-CO');
                document.getElementById('val-alerts').innerText = data.metrics.totalAlerts || 0;
                const opTable = document.getElementById('tbl-operators');
                if (data.operators && data.operators.length > 0) {
                    opTable.innerHTML = data.operators.map(op => "<tr><td><strong>" + op.operatorName + "</strong></td><td>" + (op.activeChatId ? 'Cliente #' + op.activeChatId : 'En espera') + "</td><td><span class='badge badge-active'>EN LÍNEA</span></td></tr>").join('');
                }
                const fineTable = document.getElementById('tbl-fines');
                if (data.fines && data.fines.length > 0) {
                    fineTable.innerHTML = data.fines.slice(0, 10).map(f => "<tr><td><strong>" + f.operatorName + "</strong></td><td>" + f.reason + "</td><td><span class='badge badge-danger'>$" + f.fineAmount.toLocaleString('es-CO') + "</span></td></tr>").join('');
                }
            } catch (e) {}
        }
        setInterval(updateDashboard, 3000);
        updateDashboard();
    </script>
</body>
</html>
    `);
});

// ==========================================
// 6. ARRANQUE
// ==========================================
app.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(`🚀 RYR TITAN APEX BACKEND INICIADO EN PUERTO: ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`====================================================`);
    await autoDiscoverGroqModel();
});
