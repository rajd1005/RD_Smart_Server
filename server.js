const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { pool } = require('./database'); // Removed initDb to avoid auto-reset
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

// HELPER: Force IST Time String
function getISTTime() {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// --- 1. SIGNAL DETECTED (Arrow Appears) ---
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type, time } = req.body; // 'time' comes from MT4 (Signal Bar Time)
    const istTime = getISTTime();

    try {
        // Send Root Message
        const msg = `⚠️ **NEW SIGNAL DETECTED**\nSymbol: ${symbol}\nDir: ${type}\nTime: ${istTime}`;
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });

        // Save to DB (Status = SIGNAL)
        const query = `
            INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status)
            VALUES ($1, $2, $3, $4, $5, 'SIGNAL')
            ON CONFLICT (trade_id) DO NOTHING;
        `;
        await pool.query(query, [trade_id, symbol, type, sentMsg.message_id, istTime]);

        res.json({ success: true });
        console.log(`⚠️ Signal: ${symbol}`);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- 2. SETUP CONFIRMED (Entry/SL/TP Calculated) ---
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, entry, sl, tp1, tp2, tp3 } = req.body;

    try {
        // Find the Trade to get the Telegram Message ID
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Signal not found" });
        const trade = lookup.rows[0];

        // Update DB with Levels
        await pool.query(
            "UPDATE trades SET entry_price=$1, sl_price=$2, tp1_price=$3, tp2_price=$4, tp3_price=$5, status='SETUP' WHERE trade_id=$6",
            [entry, sl, tp1, tp2, tp3, trade_id]
        );

        // Reply to Telegram
        const msg = `📋 **TRADE SETUP**\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
        await bot.sendMessage(CHAT_ID, msg, { reply_to_message_id: trade.telegram_msg_id, parse_mode: 'Markdown' });

        res.json({ success: true });
        console.log(`📋 Setup: ${trade.symbol}`);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- 3. ENTRY ACTIVATED ---
app.post('/api/entry_activated', async (req, res) => {
    const { trade_id } = req.body;
    try {
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
        const trade = lookup.rows[0];

        await pool.query("UPDATE trades SET status='ACTIVE' WHERE trade_id=$1", [trade_id]);

        // Reply
        await bot.sendMessage(CHAT_ID, `🚀 **UPDATE: Entry Activated**`, { reply_to_message_id: trade.telegram_msg_id, parse_mode: 'Markdown' });
        
        res.json({ success: true });
    } catch (err) { console.error(err); }
});

// --- 4. TP / SL UPDATES ---
app.post('/api/update', async (req, res) => {
    const { trade_id, status, close_price } = req.body;
    try {
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
        const trade = lookup.rows[0];

        // Calculate POINTS (Raw Difference)
        let points = (trade.type === 'BUY') ? (close_price - trade.entry_price) : (trade.entry_price - close_price);
        // Normalize for display (Optional: Multiply by 100/10000 if you want standard points, otherwise raw)
        // User requested "Points" usually implies "Pipettes" or "Standard Pips" depending on broker. 
        // Here we store RAW price diff for accuracy or multiply for readability.
        // Let's use Standard MT4 Points logic (Raw Price / Point Size approx).
        // For simplicity in Frontend, we save the raw diff, or a readable format.
        // Let's just save the raw difference for now, frontend handles display.

        await pool.query("UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3", [status, points, trade_id]);

        const msg = `🚀 **UPDATE: ${status}**\nPoints: ${points.toFixed(5)}`;
        await bot.sendMessage(CHAT_ID, msg, { reply_to_message_id: trade.telegram_msg_id, parse_mode: 'Markdown' });

        res.json({ success: true });
    } catch (err) { console.error(err); }
});

app.get('/api/trades', async (req, res) => {
    const result = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT 100");
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
