const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
// CLAVES DE IA (Configura ambas en Render para fallo cero)
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const liveTelemetryMap = new Map();
const recentChatAuditsRAM = new Map();

// 1. MOTOR DE IA MAESTRO (GROQ con Fallback a OpenAI)
async function callAiEngine(systemPrompt, userPrompt) {
  // Intento 1: GROQ (Ultra rápido)
  if (GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "llama3-70b-8192",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          temperature: 0.7
        })
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    } catch (e) { console.error("Fallo Groq, saltando a OpenAI..."); }
  }

  // Intento 2: OpenAI (Máxima confiabilidad)
  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "Error: Motores de IA fuera de línea.";
    } catch (e) { return "Error crítico de conexión."; }
  }
  return "Configure las API Keys en el servidor.";
}

// 2. ENDPOINT: ASISTENTE ESTRATEGA (Para el operador)
app.post('/api/intelligence/query', async (req, res) => {
  const { query, liveMarkdown, clientName, profileName } = req.body;
  
  const systemPrompt = `Eres un experto estratega en dating de la agencia RYR TITAN. 
  Tu objetivo: Analizar el chat y ayudar al operador a FACTURAR MÁS moviendo al usuario de CHAT a CARTAS.
  - Identifica si el usuario está emocionado, solo o tiene curiosidad profunda: ¡Esa es la señal para CARTA!
  - REGLA: Nunca Travel Misleading (prometer verse).
  - Si detectas oportunidad de carta, di: "🚨 ¡OPORTUNIDAD DE CARTA DETECTADA!" y da el mensaje gancho.
  - Usa el historial adjunto para ser coherente.`;

  const answer = await callAiEngine(systemPrompt, `Contexto: Perfil ${profileName} hablando con ${clientName}.\nHistorial:\n${liveMarkdown}\nPregunta: ${query}`);
  res.json({ answer });
});

// 3. ENDPOINT: ANALIZADOR DE PATRONES (Para el monitor)
app.post('/api/chats/analyze-patterns', async (req, res) => {
  const { markdown } = req.body;
  const systemPrompt = `Eres un auditor forense de chats de dating. Analiza este historial y busca errores del operador:
  1. Manipulación agresiva para regalos (pedir directamente sin mérito).
  2. Error de identidad (llamar al perfil por otro nombre).
  3. Pérdida de hilo/contexto (no responder a lo que el cliente pregunta).
  4. Mal trato.
  Responde con un puntaje de 0 a 100 y una lista de alertas ROJAS.`;

  const report = await callAiEngine(systemPrompt, markdown);
  res.json({ report });
});

// ... (Demás endpoints de telemetría y multas que ya tenías)

app.listen(PORT, () => console.log(`🚀 Master AI Engine V3.0 activo en puerto ${PORT}`));
