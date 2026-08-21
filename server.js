// ==========================================
// ENDPOINT: CO-PILOTO & ANALISTA ESTRATÉGICO IA
// ==========================================
app.post('/api/intelligence/query', async (req, res) => {
    try {
        const { clientId, query, clientData, operatorName } = req.body;

        if (!clientId || !query) {
            return res.status(400).json({ success: false, error: 'clientId y query son requeridos.' });
        }

        // 1. Obtener todo el historial de chat acumulado de este cliente (Memoria o Supabase)
        let fullChatHistory = memoryStore.chatMarkdownLogs[clientId] || '';

        if (!fullChatHistory && supabase) {
            const { data, error } = await supabase
                .from('chat_audits')
                .select('chat_markdown')
                .eq('client_id', String(clientId))
                .order('created_at', { ascending: false })
                .limit(1);

            if (data && data.length > 0) {
                fullChatHistory = data[0].chat_markdown;
            }
        }

        // 2. Construir el contexto del cliente
        const clientContext = `
=== FICHA DEL CLIENTE (ID: ${clientId}) ===
Nombre / Perfil: ${clientData?.name || 'Desconocido'}
Ubicación: ${clientData?.location || 'No especificada'}
Edad / Nacimiento: ${clientData?.age || clientData?.birthdate || 'No especificada'}
Estado civil / Detalles: ${clientData?.relationship || 'No especificado'}

=== HISTORIAL REAL DE CONVERSACIONES ===
${fullChatHistory ? fullChatHistory : 'No hay historial previo registrado en la base de datos para este usuario.'}
`;

        // 3. System Prompt de Alta Precisión (Cero roleplay, Razonamiento puro estilo ChatGPT)
        const systemPrompt = `
Eres el **Analista de Inteligencia y Co-Piloto Estratégico RYR Titan Apex**.
Tu usuario es un OPERADOR HUMANO de la plataforma que te hace preguntas sobre el cliente con el que está chateando.

TU OBJETIVO:
Responder con máxima precisión, razonamiento crítico y análisis directo a las consultas del operador basándote EXCLUSIVAMENTE en el historial real y la ficha del cliente suministrada.

⚠️ REGLAS ESTRICTAS DE RESPUESTA:
1. **PROHIBIDO EL ROLEPLAY O SIMULAR DIÁLOGOS**: NUNCA inventes conversaciones ficticias tipo "Operador: ..." o "${clientData?.name || 'Cliente'}: ...". Tú eres un asesor analítico que le habla directamente al operador.
2. **RESPONDE DIRECTAMENTE A LA PREGUNTA**:
   - Si pregunta si tiene hijos: Revisa el historial y responde si tiene o no, citando qué dijo el cliente (por ejemplo: "No tiene hijos humanos. En el chat del [fecha/hora] mencionó que tiene dos gatos que considera como sus hijos y que cuida a su madre.").
   - Si pregunta qué le gusta: Enumera sus intereses reales extraídos del chat.
   - Si te pide una idea de respuesta para enviarle al cliente: Dale sugerencias persuasivas, inteligentes y naturales, basadas en sus gustos reales, sin caer en Travel Misleading (prohibido prometer viajes o citas en persona).
3. **CERO PLANTILLAS O TEXTOS GENÉRICOS**: Cada respuesta debe ser única y fundamentada en lo que el cliente realmente ha escrito.
4. **IDIOMA**: Responde en Español claro y profesional (a menos que el operador te pida redactar un mensaje en inglés para enviarlo al cliente).
5. **HONESTIDAD DE DATOS**: Si la información preguntada no existe en el historial, responde claramente: "En el historial actual no ha mencionado información sobre [tema]."
`;

        // 4. Ejecutar consulta con Groq
        const groqModel = await autoDiscoverGroqModel();
        
        const completion = await groq.chat.completions.create({
            model: groqModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${clientContext}\n\nPREGUNTA DEL OPERADOR: "${query}"\n\nResponde como asesor analítico:` }
            ],
            temperature: 0.2, // Temperatura baja para respuestas exactas, analíticas y sin alucinaciones
            max_tokens: 600
        });

        const reply = completion.choices[0]?.message?.content || 'No se pudo generar una respuesta.';

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

