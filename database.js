const { Pool } = require('pg');
require('dotenv').config();

// Connect to Railway PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Initialize Table if not exists
const initDb = async () => {
    const query = `
    CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        trade_id VARCHAR(50) UNIQUE NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(10) NOT NULL,
        entry_price DECIMAL DEFAULT 0,
        sl_price DECIMAL DEFAULT 0,
        tp1_price DECIMAL DEFAULT 0,
        tp2_price DECIMAL DEFAULT 0,
        tp3_price DECIMAL DEFAULT 0,
        status VARCHAR(20) DEFAULT 'OPEN',
        pips_gained DECIMAL DEFAULT 0,
        telegram_msg_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    `;
    try {
        await pool.query(query);
        console.log("✅ Database Table Verified/Created");
    } catch (err) {
        console.error("❌ Database Error:", err);
    }
};

module.exports = { pool, initDb };
