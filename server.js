/**
 * ============================================================================
 * RYR TITAN APEX - BACKEND CORE & CO-PILOTO ANALÍTICO IA
 * ============================================================================
 */

try { require('dotenv').config(); } catch (e) {}

let createClient, Groq;
try { createClient = require('@supabase/supabase-js').createClient; } catch (e) {}
try { Groq = require('groq-sdk'); } catch (e) {}

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = (createClient && SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groq = (Groq && GROQ_API_KEY) ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// Modelo oficial estable y de alto razonamiento de Groq
const GROQ_STABLE_MODEL = 'llama-3.3-70b-versatile';

// Memoria en tiempo real
const memoryStore = {
    operators: {},
    chatMarkdownLogs: {},
    clientProfiles: {},
    alerts: [],
    fines: [],
    metrics: { totalAudits: 0, totalFinesCOP: 0, totalAlerts: 0 }
};

const FINE_VALUE_COP = 10000;

const FORBIDDEN_TRAVEL_PATTERNS = [
    /voy a ir a verte/i, /te ir[eé] a visitar/i, /vamos a vernos pronto/i,
    /comprar[eé] el pasaje/i, /viajar[eé] a tu pa[ií]s/i, /meet in person soon/i,
    /buy (a )?ticket to see you/i, /i will visit you/i, /i am coming to your country/i
];

function analyzeTravelMisleadingHeuristic(text) {
    if (!text || typeof text !== 'string') return { detected: false };
    for (const pattern of FORBIDDEN_TRAVEL_PATTERNS) {
        if (pattern.test(text)) {
            return { detected: true, type: 'TRAVEL_MISLEADING', matched: pattern.toString(), fineAmount: FINE_VALUE_COP };
        }
    }
    return { detected: false };
}

// Rutas de Expediente
const handleGetExpediente = async (req, res) => {
    try {
        const clientId = req.params.clientId;
        let chatMarkdown = memoryStore.chatMarkdownLogs[clientId] || '';
        let clientData = memoryStore.clientProfiles[clientId] || {};

        if (supabase && (!chatMarkdown || !clientData.name)) {
            const { data } = await supabase
                .from('chat_audits')
                .select('*')
                .eq('client_id', String(clientId))
                .order('last_updated', { ascending: false })
                .limit(1);

            if (data && data.length > 0) {
                chatMarkdown = data[0].chat_markdown || chatMarkdown;
                clientData.name = data[0].client_name || clientData.name;
            }
        }

        return res.json({
            success: true,
            clientId,
            name: clientData.name || `Usuario_${clientId}`,
            location: clientData.location || 'No especificada',
            birthdate: clientData.birthdate || 'No especificado',
            age: clientData.age || 'No especificada',
            relationship: clientData.relationship || 'Not married',
            plans: clientData.plans || 'Activo',
            synced: true,
            chat_markdown: chatMarkdown
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

app.get('/api/intelligence/user/:clientId', handleGetExpediente);
app.get('/api/intelligence/expediente/:clientId', handleGetExpediente);
app.get('/api/expediente/:clientId', handleGetExpediente);

// Telemetría
app.post('/api/telemetry', (req, res) => {
    const { operatorId, operatorName, activeChatId, chatOpenTime } = req.body;
    if (!operatorId) return res.status(400).json({ error: 'operatorId requerido' });
    memoryStore.operators[operatorId] = {
        operatorId,
        operatorName: operatorName || `Operador_${operatorId}`,
        activeChatId: activeChatId || null,
        chatOpenTime: chatOpenTime || Date.now(),
        lastSeen: Date.now()
    };
    res.json({ success: true });
});

// Auditoría y guardado de chats
app.post('/api/audit', async (req, res) => {
    try {
        const { operatorId, operatorName, clientId, clientName, clientData, messageText, sender, chatMarkdownFull } = req.body;
        if (!clientId) return res.status(400).json({ success: false, error: 'clientId requerido' });

        memoryStore.metrics.totalAudits++;

        if (clientData) {
            memoryStore.clientProfiles[clientId] = {
                ...memoryStore.clientProfiles[clientId],
                ...clientData,
                name: clientName || clientData.name
            };
        }

        if (chatMarkdownFull) {
            memoryStore.chatMarkdownLogs[clientId] = chatMarkdownFull;
        } else if (messageText) {
            const formatted = `[${new Date().toLocaleTimeString()}] ${sender || 'Desconocido'}: ${messageText}\n`;
            memoryStore.chatMarkdownLogs[clientId] = (memoryStore.chatMarkdownLogs[clientId] || '') + formatted;
        }

        // Detección de infracciones
        let infraction = null;
        if (sender && (sender.toLowerCase().includes('operador') || sender.toLowerCase().includes('you'))) {
            const heuristic = analyzeTravelMisleadingHeuristic(messageText);
            if (heuristic.detected) {
                infraction = {
                    operatorId: operatorId || 'N/A',
                    operatorName: operatorName || 'Operador',
                    clientId,
                    reason: 'Travel Misleading (Promesa de viaje/cita)',
                    fineAmount: FINE_VALUE_COP,
                    timestamp: new Date().toISOString()
                };
                memoryStore.fines.unshift(infraction);
                memoryStore.metrics.totalFinesCOP += FINE_VALUE_COP;
                if (supabase) supabase.from('operator_fines').insert([infraction]);
            }
        }

        // Sincronización con Supabase
        if (supabase) {
            await supabase.from('chat_audits').upsert([{
                client_id: String(clientId),
                client_name: clientName || memoryStore.clientProfiles[clientId]?.name || null,
                operator_id: operatorId || null,
                chat_markdown: memoryStore.chatMarkdownLogs[clientId],
                last_updated: new Date().toISOString()
            }], { onConflict: 'client_id' });
        }

        return res.json({ success: true, infractionDetected: !!infraction });
    } catch (err) {
        console.error('❌ [Audit Error]:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Co-Piloto IA Analítico (ChatGPT puro)
app.post(['/api/intelligence/query', '/api/intelligence/ask'], async (req, res) => {
    try {
        const { clientId, query, clientData, operatorName } = req.body;
        if (!clientId || !query) return res.status(400).json({ success: false, error: 'clientId y query requeridos' });

        let fullChatHistory = memoryStore.chatMarkdownLogs[clientId] || '';
        if (!fullChatHistory && supabase) {
            const { data } = await supabase
                .from('chat_audits')
                .select('chat_markdown')
                .eq('client_id', String(clientId))
                .limit(1);
            if (data && data.length > 0) fullChatHistory = data[0].chat_markdown;
        }

        const profile = clientData || memoryStore.clientProfiles[clientId] || {};

        const context = `
=== FICHA DEL CLIENTE (ID: ${clientId}) ===
Nombre: ${profile.name || 'Desconocido'}
Edad: ${profile.age || 'No especificada'}
Ubicación: ${profile.location || 'No especificada'}
Estado Civil / Planes: ${profile.relationship || 'Not married'}

=== HISTORIAL REAL DE CONVERSACIONES ===
${fullChatHistory || 'Sin historial de conversación registrado aún.'}
`;

        const systemPrompt = `
Eres el **Analista de Inteligencia RYR Titan Apex**.
Tu usuario es un OPERADOR HUMANO de Talkytimes. Tu misión es responder a sus preguntas analizando objetivamente la ficha y el historial del cliente.

REGLAS OBLIGATORIAS:
1. **PROHIBIDO EL ROLEPLAY O DIÁLOGOS SIMULADOS**: NUNCA respondas con "Operador:..." o "${profile.name}:...". Habla tú directamente como analista al operador.
2. **RESPUESTAS PRECISAS Y RAZONADAS (ESTILO LLM/CHATGPT)**:
   - Si preguntan si tiene hijos, lee el historial y responde con hechos (ej: "No tiene hijos propios. En el chat comentó que tiene 2 gatos a los que trata como sus hijos y cuida a su madre.").
   - Si preguntan qué le gusta, extrae sus gustos reales del chat.
   - Si piden un mensaje sugerido, redáctalo persuasivo, coherente con sus gustos y CERO promesas de viajes/visitas (Travel Misleading).
3. **CERO PLANTILLAS**: Respuestas directas, fundamentadas e inteligentes.
4. **IDIOMA**: Español claro y profesional.
`;

        if (!groq) {
            return res.json({ success: true, reply: 'Error: GROQ_API_KEY no configurada en el servidor.' });
        }

        const completion = await groq.chat.completions.create({
            model: GROQ_STABLE_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${context}\n\nPREGUNTA DEL OPERADOR: "${query}"\n\nRespuesta analítica directa:` }
            ],
            temperature: 0.2,
            max_tokens: 650
        });

        const reply = completion.choices[0]?.message?.content?.trim() || 'No se pudo generar la respuesta.';

        return res.json({
            success: true,
            modelUsed: GROQ_STABLE_MODEL,
            reply: reply,
            response: reply,
            answer: reply
        });

    } catch (err) {
        console.error('❌ [Groq Error]:', err.message);
        return res.status(500).json({ success: false, error: err.message, reply: `Error: ${err.message}` });
    }
});

app.get('/api/dashboard-data', (req, res) => {
    res.json({
        metrics: memoryStore.metrics,
        activeOperatorsCount: Object.keys(memoryStore.operators).length,
        operators: Object.values(memoryStore.operators),
        fines: memoryStore.fines.slice(0, 30)
    });
});

app.listen(PORT, () => {
    console.log(`🚀 RYR TITAN APEX BACKEND LISTO EN PUERTO: ${PORT}`);
    console.log(`🤖 Modelo Groq fijado: ${GROQ_STABLE_MODEL}`);
});
