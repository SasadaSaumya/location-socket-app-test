const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME
});

pool.query('SELECT NOW()')
    .then((res) => {
        console.log(`DB Connected to PostgreSQL. Server time: ${res.rows[0].now}`);
    })
    .catch((err) => {
        console.error('DB Connection failed:', err.message);
    });

pool.on('error', (err) => {
    console.error('DB error on idle client:', err.message);
});

module.exports = pool;
