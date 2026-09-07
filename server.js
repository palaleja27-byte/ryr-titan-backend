// ENDPOINT: GENERAR Y GUARDAR RELEVO DE TURNO CON IA
app.post('/api/handover/generate-and-save', async (req, res) => {
  const { operator, shift, profileName, profileId } = req.body;
  if (!profileName) return res.status(400).json({ error: 'Perfil requerido' });

  // Recopilar los últimos chats guardados de este perfil
  const recentAudits = Array.from(recentChatAuditsRAM.values())
    .filter(a => a.profile === profileName)
    .slice(0, 10);

  let consolidatedContext = recentAudits.map(a => `CLIENTE: ${a.clientName} (ID: ${a.clientId})\n${a.markdown}`).join('\n\n---\n\n');

  if (!consolidatedContext) {
    consolidatedContext = 'Sin historial específico guardado en este turno.';
  }

  const targetModel = await getAvailableGroqModel(GROQ_API_KEY);
  const prompt = `Eres el Coordinador de Turnos de RYR TITAN.
Genera un REPORTE DE RELEVO DE TURNO conciso y directo para el operador entrante del siguiente turno.

OPERADOR SALIENTE: ${operator} | TURNO: ${shift} | PERFIL: ${profileName} (${profileId})

HISTORIAL DE CLIENTES ATENDIDOS:
${consolidatedContext}

ESTRUCTURA DEL REPORTE:
1. Resumen de clientas atendidas y estado emocional de cada una.
2. Temas de conversación clave y compromisos hablados.
3. Clientas con cartas/créditos pendientes.
4. Instrucciones y consejos tácticos para el siguiente turno.`;

  let reportText = '';
  try {
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 1000
      })
    });
    const data = await aiRes.json();
    reportText = data.choices[0]?.message?.content?.replace(/\*\*/g, '') || 'Relevo generado con éxito.';
  } catch (e) {
    reportText = `📋 Relevo de Turno (${shift}) - Perfil ${profileName}:\nSe atendieron conversaciones activas. Continuar con el flujo normal de chat y seguimiento.`;
  }

  const handoverEntry = {
    id: `HANDOVER_${profileName}_${Date.now()}`,
    operator_name: operator,
    shift: shift,
    profile_name: profileName,
    reportMarkdown: reportText,
    created_at: new Date().toISOString()
  };

  recentChatAuditsRAM.set(`LATEST_HANDOVER_${profileName}`, handoverEntry);

  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/shift_handovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(handoverEntry)
    }).catch(() => {});
  }

  res.json({ success: true, handover: handoverEntry });
});

app.get('/api/handover/latest', (req, res) => {
  const profileName = req.query.profileName;
  const entry = recentChatAuditsRAM.get(`LATEST_HANDOVER_${profileName}`);
  res.json({ success: Boolean(entry), handover: entry || null });
});
