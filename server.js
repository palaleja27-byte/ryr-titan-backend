const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión en SOLO LECTURA a tu proyecto de Supabase (AgenciaRR-V2)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Endpoint para obtener Operadores reales
app.get('/api/operadores', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('operadores')
      .select('*');

    if (error) throw error;
    res.json({ success: true, operadores: data });
  } catch (err) {
    console.error('Error leyendo tabla operadores:', err.message);
    res.status(500).json({ error: 'Error al consultar operadores' });
  }
});

// Endpoint para obtener Perfiles reales desde datame_perfiles
app.get('/api/perfiles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('datame_perfiles')
      .select('id_datame, modelo')
      .order('modelo', { ascending: true });

    if (error) throw error;
    
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
