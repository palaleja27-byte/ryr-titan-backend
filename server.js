const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Helper para consultas REST directas a Supabase
async function querySupabase(endpoint) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase API error: ${response.statusText}`);
  }

  return await response.json();
}

// Endpoint para Operadores
app.get('/api/operadores', async (req, res) => {
  try {
    const data = await querySupabase('operadores?select=*');
    res.json({ success: true, operadores: data });
  } catch (err) {
    console.error('Error leyendo tabla operadores:', err.message);
    res.status(500).json({ error: 'Error al consultar operadores' });
  }
});

// Endpoint para Perfiles desde datame_perfiles
app.get('/api/perfiles', async (req, res) => {
  try {
    const data = await querySupabase('datame_perfiles?select=id_datame,modelo&order=modelo.asc');
    
    const perfilesFormat = data.map(p => ({
      id: p.id_datame,
      name: p.modelo
    }));

    res.json({ success: true, perfiles: perfilesFormat });
  } catch (err) {
    console.error('Error leyendo tabla datame_perfiles:', err.message);
    res.status(500).json({ error: 'Error al consultar perfiles' });
  }
});

// Endpoint de Telemetría
app.post('/api/telemetry', (req, res) => {
  console.log('[TELEMETRY RECEIVED]', req.body);
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
