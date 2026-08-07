const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a Supabase mediante Variable de Entorno
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Endpoint 1: Login de Operador y Retorno de Perfiles Asignados
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query(
      'SELECT id, username, shift FROM operators WHERE username = $1 AND password = $2',
      [username, password]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const operator = userRes.rows[0];

    // Consulta de Perfiles Oficiales asignados
    const profilesRes = await pool.query(
      `SELECT p.profile_name 
       FROM profiles p 
       JOIN operator_profiles op ON p.id = op.profile_id 
       WHERE op.operator_id = $1`,
      [operator.id]
    );

    res.json({
      success: true,
      operator: operator.username,
      shift: operator.shift,
      profiles: profilesRes.rows.map(r => r.profile_name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint 2: Recepción de Alertas/Telemetría en Tiempo Real
app.post('/api/telemetry', async (req, res) => {
  const { operator, shift, profile, eventType, details } = req.body;
  try {
    await pool.query(
      `INSERT INTO telemetry_logs (operator_name, shift, profile_name, event_type, details) 
       VALUES ($1, $2, $3, $4, $5)`,
      [operator, shift, profile, eventType, JSON.stringify(details)]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor RYR corriendo en puerto ${PORT}`));