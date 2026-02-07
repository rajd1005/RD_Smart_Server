const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { pool, initDb } = require('./database');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves the Frontend Files

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

// --- API: RECEIVE NEW SIGNAL FROM MT4 ---
app.post('/api/signal', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3 } = req.body;

    try {
        // 1. Send to Telegram (NEW MESSAGE)
        const msg = `⚠️ **NEW SIGNAL DETECTED**\nSymbol: ${symbol}\nType: ${type}\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}`;
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });

        // 2. Save to Database with Message ID (For Replying later)
        const query = `
            INSERT INTO trades (trade_id, symbol, type, entry_price, sl_price, tp1_price, tp2_price, tp3_price, telegram_msg_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, sentMsg.message_id];
        const result = await pool.query(query, values);

        res.json({ success: true, id: result.rows[0].id });
        console.log(`✅ New Trade Logged: ${symbol} (${type})`);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- API: UPDATE SIGNAL (TP/SL HIT) ---
app.post('/api/update', async (req, res) => {
    const { trade_id, status, close_price } = req.body;

    try {
        // 1. Get original trade info
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });

        const trade = lookup.rows[0];
        
        // 2. Calculate Pips
        let pips = 0;
        if (trade.type === 'BUY') pips = (close_price - trade.entry_price);
        else pips = (trade.entry_price - close_price);
        
        // Adjust for JPY pairs (simplistic check)
        if (trade.symbol.includes("JPY")) pips = pips * 100;
        else pips = pips * 10000; 

        // 3. Update Database
        await pool.query(
            "UPDATE trades SET status = $1, pips_gained = $2, updated_at = NOW() WHERE trade_id = $3",
            [status, pips, trade_id]
        );

        // 4. Send REPLY to the Original Telegram Message
        const replyMsg = `🚀 **UPDATE: ${status}**\n${trade.symbol} ${trade.type}\nPips: ${pips.toFixed(1)}`;
        await bot.sendMessage(CHAT_ID, replyMsg, { 
            reply_to_message_id: trade.telegram_msg_id 
        });

        res.json({ success: true });
        console.log(`🔄 Trade Updated: ${trade_id} -> ${status}`);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- API: GET ALL TRADES FOR DASHBOARD ---
app.get('/api/trades', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM trades ORDER BY created_at DESC LIMIT 100");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDb();
    console.log(`🚀 Server running on port ${PORT}`);
});
