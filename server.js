// --- REPLACE YOUR EXISTING server.js WITH THIS ---
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { pool, initDb } = require('./database');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

// HELPER: Get Current Time in India (IST)
function getISTTime() {
    return new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
}

// --- API: RECEIVE NEW SIGNAL ---
app.post('/api/signal', async (req, res) => {
    // Note: We ignore the time sent from MT4. We use Server Time converted to IST.
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3 } = req.body;
    const istTime = getISTTime(); // "2/7/2026, 5:30:00 PM"

    try {
        // 1. Send to Telegram
        const msg = `⚠️ **NEW SIGNAL**\nSymbol: ${symbol}\nType: ${type}\nEntry: ${entry}\nSL: ${sl}\nTime: ${istTime}`;
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });

        // 2. Save to DB with IST Time
        const query = `
            INSERT INTO trades (trade_id, symbol, type, entry_price, sl_price, tp1_price, tp2_price, tp3_price, telegram_msg_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *;
        `;
        // We insert 'istTime' into created_at. Ensure your DB column is TIMESTAMP or TEXT.
        // If DB is strict TIMESTAMP, it might convert back to UTC. 
        // For display purposes, storing as Text or handling display in Frontend is safer, 
        // but here we send the timestamp string.
        const values = [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, sentMsg.message_id, istTime];
        await pool.query(query, values);

        res.json({ success: true, time_saved: istTime });
        console.log(`✅ Trade ${symbol} logged at ${istTime} (IST)`);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- API: UPDATE SIGNAL ---
app.post('/api/update', async (req, res) => {
    const { trade_id, status, close_price } = req.body;
    try {
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
        
        const trade = lookup.rows[0];
        let pips = (trade.type === 'BUY') ? (close_price - trade.entry_price) : (trade.entry_price - close_price);
        
        // Auto-Adjust Decimals for JPY/Gold
        if (trade.symbol.includes("JPY") || trade.symbol.includes("XAU")) pips = pips * 100; // Approx for Gold/JPY
        else pips = pips * 10000;

        await pool.query("UPDATE trades SET status = $1, pips_gained = $2 WHERE trade_id = $3", [status, pips, trade_id]);

        // Reply to Telegram
        const replyMsg = `🚀 **UPDATE: ${status}**\n${trade.symbol}\nPips: ${pips.toFixed(1)}`;
        await bot.sendMessage(CHAT_ID, replyMsg, { reply_to_message_id: trade.telegram_msg_id });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/trades', async (req, res) => {
    const result = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT 100");
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initDb();
    console.log(`🚀 Server running on port ${PORT}`);
});
