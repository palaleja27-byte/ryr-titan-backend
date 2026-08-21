/**
 * ============================================================================
 * RYR TITAN APEX - BACKEND CORE & CO-PILOTO ANALÍTICO IA
 * ============================================================================
 * Stack: Node.js, Express, Groq SDK, Supabase
 * Diseñado para despliegue en Render
 */

// Carga segura de dotenv (si no está instalado en Render, no romperá la app)
try {
    require('dotenv').config();
} catch (e) {
    // En Render las variables de entorno se leen directo de process.env
}

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ==========================================
// 1. INICIALIZACIÓN DE SERVICIOS EXTERNOS
// ==========================================

// Supabase Client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('✅ [Supabase]: Conexión establecida correctamente.');
    } catch (err) {
        console.warn('⚠️ [Supabase Warn]: No se pudo conectar a Supabase:', err.message);
    }
} else {
    console.warn('⚠️ [Supabase Warn]: Faltan SUPABASE_URL o SUPABASE_KEY en variables de entorno.');
}

// Groq Client
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groq = null;
if (GROQ_API_KEY) {
    groq = new Groq({ apiKey: GROQ_API_KEY });
    console.log('✅ [Groq]: SDK inicializado con éxito.');
} else {
    console.warn('⚠️ [Groq Warn]: Falta GROQ_API_KEY en variables de entorno.');
}

// ==========================================
// 2. AUTO-DISCOVERY DE MODELOS GROQ
// ==========================================
let cachedGroqModel = null;
let lastModelCheck = 0;

async function autoDiscoverGroqModel() {
    const now = Date.now();
    // Cache de 1 hora para el modelo seleccionado
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

        // Fallback al primer modelo activo disponible
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
// 3. MEMORIA VOLÁTIL / ESTADO EN TIEMPO REAL
// ==========================================
const memoryStore = {
    operators: {},          // Telemetría de operadores
    chatMarkdownLogs: {},   // Markdown acumulado por cliente: { [clientId]: "..." }
    clientProfiles: {},     // Metadatos de perfiles analizados
    alerts: [],             // Alertas en tiempo real
    fines: [],              // Multas registradas
    metrics: {
        totalAudits: 0,
        totalFinesCOP: 0,
        totalAlerts: 0
    }
};

const FINE_VALUE_COP = 10000; // $10,000 COP por infracción

// ==========================================
// 4. MOTOR HEURÍSTICO & DETECCIÓN DE INFRACCIONES
// ==========================================
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
// 5. RUTAS DEL SERVIDOR
// ==========================================

// Health Check
app.get('/', (req, res) => {
    res.json({
        service: 'RYR Titan Apex Core',
        status: 'ONLINE',
        supabaseStatus: supabase ? 'CONNECTED' : 'DISCONNECTED',
        groqStatus: groq ? 'CONNECTED' : 'DISCONNECTED',
        timestamp: new Date().toISOString()
    });
});

// ------------------------------------------
// TELEMETRÍA DE OPERADORES & SLA
// ------------------------------------------
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

// ------------------------------------------
// INGESTA & AUDITORÍA DE CONVERSACIONES
// ------------------------------------------
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

        if (!clientId) {
            return res.status(400).json({ success: false, error: 'clientId es requerido' });
        }

        memoryStore.metrics.totalAudits++;

        // 1. Guardar/Actualizar Markdown en Memoria
        if (chatMarkdownFull) {
            memoryStore.chatMarkdownLogs[clientId] = chatMarkdownFull;
        } else if (messageText) {
            const formatted = `[${timestamp || new Date().toLocaleTimeString()}] ${sender || 'Desconocido'}: ${messageText}\n`;
            memoryStore.chatMarkdownLogs[clientId] = (memoryStore.chatMarkdownLogs[clientId] || '') + formatted;
        }

        // 2. Análisis Heurístico Inmediato (Anti-Travel Misleading)
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

                // Guardar multa en Supabase si está disponible
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

        // 3. Sincronizar log de chat a Supabase (asíncrono)
        if (supabase && (chatMarkdownFull || messageText)) {
            supabase.from('chat_audits').upsert([{
                client_id: String(clientId),
                client_name: clientName || null,
                operator_id: operatorId || null,
                chat_markdown: memoryStore.chatMarkdownLogs[clientId],
                last_updated: new Date().toISOString()
            }], { onConflict: 'client_id' }).then(({ error }) => {
                if (error) console.error('❌ [Supabase Audit Sync Error]:', error.message);
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

// -----------------------------------------------------------
// CO-PILOTO & ANALISTA ESTRATÉGICO IA (SIN ROLEPLAY / CHATGPT)
// -----------------------------------------------------------
app.post('/api/intelligence/query', async (req, res) => {
    try {
        const { clientId, query, clientData, operatorName } = req.body;

        if (!clientId || !query) {
            return res.status(400).json({ success: false, error: 'clientId y query son requeridos.' });
        }

        // 1. Obtener historial acumulado (RAM -> Supabase)
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

        // 2. Construir ficha del cliente
        const clientContext = `
================ INFORMACIÓN DEL CLIENTE (ID: ${clientId}) ================
- Nombre / Perfil: ${clientData?.name || clientData?.userName || 'No especificado'}
- Ubicación: ${clientData?.location || 'No especificada'}
- Edad / Fecha Nacimiento: ${clientData?.age || clientData?.birthdate || 'No especificada'}
- Estado Civil / Intenciones: ${clientData?.relationship || 'No especificado'}
- Intereses / Notas previas: ${clientData?.interests || 'No especificados'}

================ HISTORIAL DE CONVERSACIONES REALES ================
${fullChatHistory ? fullChatHistory : 'No hay mensajes previos registrados para este cliente.'}
`;

        // 3. Prompt de Sistema de Alta Inteligencia Analítica
        const systemPrompt = `
Eres el **Analista de Inteligencia y Co-Piloto Estratégico RYR Titan Apex**.
Tu rol es asistir a un OPERADOR HUMANO resolviendo dudas puntuales, analizando el comportamiento del cliente y brindando soporte estratégico.

🚨 REGLAS ESTRICTAS DE RESPUESTA:
1. **PROHIBIDO EL ROLEPLAY / SIMULAR CHAT**: NUNCA generes diálogos ficticios como "Operador: ..." o "${clientData?.name || 'Cliente'}: ...". Tú NO eres el operador ni el cliente; eres el consultor inteligente que le responde directamente al operador.
2. **RAZONAMIENTO Y PRECISIÓN ANALÍTICA (ESTILO CHATGPT)**:
   - Si preguntan si el usuario tiene hijos, revisa el historial y responde con hechos (ej: "No tiene hijos humanos. En la conversación mencionó que cuida a su madre y tiene 2 gatos a los que trata como sus hijos.").
   - Si preguntan sobre gustos, trabajo, finanzas o intenciones, extrae directamente los hechos del historial.
   - Si el operador pide una sugerencia de mensaje para enviarle al cliente, redacta una propuesta persuasiva, natural y atractiva que use datos reales del cliente sin caer jamás en "Travel Misleading" (cero promesas de visitas o viajes).
3. **CERO PLANTILLAS GENÉRICAS**: Todo debe ser analizado y justificado con el contexto real provisto.
4. **SINCERIDAD**: Si una información no ha sido mencionada en el chat, di explícitamente: "En el historial analizado el cliente no ha mencionado información sobre [tema]."
5. **IDIOMA**: Responde siempre en Español profesional y conciso.
`;

        const groqModel = await autoDiscoverGroqModel();

        const completion = await groq.chat.completions.create({
            model: groqModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${clientContext}\n\nPREGUNTA DEL OPERADOR (${operatorName || 'Operador'}): "${query}"\n\nResponde directamente como consultor analítico:` }
            ],
            temperature: 0.2, // Temperatura baja para evitar alucinaciones y asegurar rigor analítico
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

// ------------------------------------------
// API MONITOR DATA & DASHBOARD HTML
// ------------------------------------------
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RYR Titan Apex | Control Center</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
        body { background: #0f111a; color: #e2e8f0; padding: 24px; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
        .header h1 { font-size: 24px; color: #a855f7; display: flex; align-items: center; gap: 10px; }
        .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .card-stat { background: #181b2a; border: 1px solid #232942; border-radius: 12px; padding: 20px; }
        .card-stat .title { font-size: 13px; color: #94a3b8; text-transform: uppercase; font-weight: bold; }
        .card-stat .value { font-size: 28px; font-weight: bold; margin-top: 8px; color: #f8fafc; }
        .card-stat .value.danger { color: #f43f5e; }
        .card-stat .value.success { color: #10b981; }
        .main-content { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        @media (max-width: 900px) { .main-content { grid-template-columns: 1fr; } }
        .panel { background: #181b2a; border: 1px solid #232942; border-radius: 12px; padding: 20px; }
        .panel h2 { font-size: 16px; margin-bottom: 16px; color: #cbd5e1; border-bottom: 1px solid #232942; padding-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #1e293b; }
        th { color: #94a3b8; font-weight: 600; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; }
        .badge-danger { background: rgba(244, 63, 94, 0.15); color: #f43f5e; border: 1px solid #f43f5e; }
        .badge-active { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid #10b981; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛡️ RYR TITAN APEX <span>• Live Control Monitor</span></h1>
        <div style="font-size: 13px; color: #10b981;">● SERVICIO ACTIVO</div>
    </div>

    <div class="grid-stats">
        <div class="card-stat">
            <div class="title">Operadores Activos</div>
            <div class="value success" id="val-operators">0</div>
        </div>
        <div class="card-stat">
            <div class="title">Auditorías Realizadas</div>
            <div class="value" id="val-audits">0</div>
        </div>
        <div class="card-stat">
            <div class="title">Total Multas (COP)</div>
            <div class="value danger" id="val-fines">$0</div>
        </div>
        <div class="card-stat">
            <div class="title">Alertas Críticas</div>
            <div class="value danger" id="val-alerts">0</div>
        </div>
    </div>

    <div class="main-content">
        <div class="panel">
            <h2>👥 Telemetría de Operadores en Vivo</h2>
            <table>
                <thead>
                    <tr>
                        <th>Operador</th>
                        <th>Chat Actual</th>
                        <th>Estado</th>
                    </tr>
                </thead>
                <tbody id="tbl-operators">
                    <tr><td colspan="3" style="text-align:center; color:#64748b;">Esperando datos de extensión...</td></tr>
                </tbody>
            </table>
        </div>

        <div class="panel">
            <h2>🚨 Registro de Infracciones y Multas ($10.000 COP)</h2>
            <table>
                <thead>
                    <tr>
                        <th>Operador</th>
                        <th>Causa</th>
                        <th>Monto</th>
                    </tr>
                </thead>
                <tbody id="tbl-fines">
                    <tr><td colspan="3" style="text-align:center; color:#64748b;">Sin infracciones registradas en la sesión.</td></tr>
                </tbody>
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
                    opTable.innerHTML = data.operators.map(op => \`
                        <tr>
                            <td><strong>\${op.operatorName}</strong></td>
                            <td>\${op.activeChatId ? 'Cliente #' + op.activeChatId : '<span style="color:#64748b;">En espera</span>'}</td>
                            <td><span class="badge badge-active">EN LÍNEA</span></td>
                        </tr>
                    \`).join('');
                } else {
                    opTable.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#64748b;">No hay operadores activos en este momento.</td></tr>';
                }

                const fineTable = document.getElementById('tbl-fines');
                if (data.fines && data.fines.length > 0) {
                    fineTable.innerHTML = data.fines.slice(0, 10).map(f => \`
                        <tr>
                            <td><strong>\${f.operatorName}</strong></td>
                            <td><span title="\${f.evidence}">\${f.reason}</span></td>
                            <td><span class="badge badge-danger">$\${(f.fineAmount).toLocaleString('es-CO')}</span></td>
                        </tr>
                    \`).join('');
                }
            } catch (e) {
                console.error('Error actualizando dashboard:', e);
            }
        }

        setInterval(updateDashboard, 3000);
        updateDashboard();
    </script>
</body>
</html>
    `);
});

// ==========================================
// 6. ARRANQUE DEL SERVIDOR
// ==========================================
app.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(`🚀 RYR TITAN APEX BACKEND INICIADO EN PUERTO: ${PORT}`);
    console.log(`📊 Dashboard en vivo: http://localhost:${PORT}/dashboard`);
    console.log(`====================================================`);
    
    await autoDiscoverGroqModel();
});
