const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { pool, initDb } = require('./database');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// --- CONFIG ---
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "admin123"; 

// --- SOCKET.IO SETUP ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

// --- HELPERS ---

function getISTTime() {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function getDBTime() {
    return new Date().toISOString(); 
}

function calculatePoints(type, entry, currentPrice) {
    if (!entry || !currentPrice) return 0;
    return (type === 'BUY') ? (currentPrice - entry) : (entry - currentPrice);
}

// --- CONVERTER: Fixes Underscores & Special Chars for Markdown ---
// This function escapes characters that crash Telegram Markdown
function toMarkdown(text) {
    if (text === undefined || text === null) return "";
    return String(text)
        .replace(/_/g, "\\_")  // Fixes #Brent_Crude -> #Brent\_Crude
        .replace(/\*/g, "\\*") // Fixes accidental bolding
        .replace(/\[/g, "\\[") // Fixes broken links
        .replace(/`/g, "\\`"); // Fixes code block errors
}

// --- API ENDPOINTS ---

// 1. GET ALL TRADES (Last 30 Days)
app.get('/api/trades', async (req, res) => {
    try {
        // Fetch trades from the last 30 days
        const query = `
            SELECT * FROM trades 
            WHERE CAST(created_at AS TIMESTAMP) >= NOW() - INTERVAL '30 days' 
            ORDER BY id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. SIGNAL DETECTED
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type } = req.body;
    const istTime = getISTTime();
    const dbTime = getDBTime(); 

    try {
        // ✅ FIXED: Using backticks for real newlines (No %0)
        // ✅ FIXED: Using toMarkdown() to handle underscores safely
        const msg = `🚨 *NEW SIGNAL DETECTED*

💎 *Symbol:* #${toMarkdown(symbol)}
📊 *Type:* ${toMarkdown(type)}
🕒 *Time:* ${toMarkdown(istTime)}`;

        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        
        // Insert new trade (Your existing code)
        const query = `
            INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status)
            VALUES ($1, $2, $3, $4, $5, 'SIGNAL')
            ON CONFLICT (trade_id) DO NOTHING;
        `;
        await pool.query(query, [trade_id, symbol, type, sentMsg.message_id, dbTime]);

        // ADD THIS: Auto-delete trades older than 30 days
        await pool.query("DELETE FROM trades WHERE CAST(created_at AS TIMESTAMP) < NOW() - INTERVAL '30 days'");

        io.emit('trade_update'); 
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// 3. SETUP CONFIRMED
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3 } = req.body;
    const dbTime = getDBTime();

    try {
        const oldTrades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SIGNAL', 'SETUP', 'ACTIVE') AND trade_id != $2",
            [symbol, trade_id]
        );
        for (const t of oldTrades.rows) {
            await pool.query("UPDATE trades SET status = 'CLOSED (Reversal)' WHERE trade_id = $1", [t.trade_id]);
            if(t.telegram_msg_id) {
                const revMsg = `🔄 *Trade Reversed*
❌ Closed by new signal.`;
                bot.sendMessage(CHAT_ID, revMsg, { reply_to_message_id: t.telegram_msg_id, parse_mode: 'Markdown' });
            }
        }

        const check = await pool.query("SELECT telegram_msg_id FROM trades WHERE trade_id = $1", [trade_id]);
        let msgId = check.rows[0]?.telegram_msg_id;

        const query = `
            INSERT INTO trades (trade_id, symbol, type, entry_price, sl_price, tp1_price, tp2_price, tp3_price, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SETUP', $9)
            ON CONFLICT (trade_id) 
            DO UPDATE SET 
                entry_price = EXCLUDED.entry_price, sl_price = EXCLUDED.sl_price,
                tp1_price = EXCLUDED.tp1_price, tp2_price = EXCLUDED.tp2_price, tp3_price = EXCLUDED.tp3_price,
                status = 'SETUP';
        `;
        await pool.query(query, [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, dbTime]);

        // ✅ FIXED: Clean Markdown Message
        const msg = `✅ *SETUP CONFIRMED*

💎 *Symbol:* #${toMarkdown(symbol)}
🚀 *Type:* ${toMarkdown(type)}
🚪 *Entry:* ${toMarkdown(entry)}
🛑 *SL:* ${toMarkdown(sl)}

🎯 *TP1:* ${toMarkdown(tp1)}
🎯 *TP2:* ${toMarkdown(tp2)}
🎯 *TP3:* ${toMarkdown(tp3)}`;

        const opts = { parse_mode: 'Markdown' };
        if (msgId) opts.reply_to_message_id = msgId;

        await bot.sendMessage(CHAT_ID, msg, opts);
        
        io.emit('trade_update'); 
        res.json({ success: true });

    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// 4. PRICE UPDATE
app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    try {
        const trades = await pool.query("SELECT * FROM trades WHERE symbol = $1 AND status = 'ACTIVE'", [symbol]);

        for (const t of trades.rows) {
            let currentPrice = (t.type === 'BUY') ? bid : ask;
            let points = calculatePoints(t.type, t.entry_price, currentPrice);
            
            await pool.query("UPDATE trades SET points_gained = $1 WHERE id = $2", [points, t.id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. INSTANT EVENT LOGGER
app.post('/api/log_event', async (req, res) => {
    const { trade_id, new_status, price } = req.body;
    try {
        const result = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (result.rows.length === 0) return res.json({ success: false, msg: "Trade not found" });

        const trade = result.rows[0];

        // --- PROFIT LOCK LOGIC ---
        if (trade.status.includes('TP') && new_status === 'SL HIT') {
            console.log(`🛡️ Profit Locked for ${trade.symbol}. Ignoring SL Signal.`);
            return res.json({ success: true, msg: "Profit Locked: SL Ignored" });
        }
        if (trade.status === 'TP3 HIT' && (new_status === 'TP2 HIT' || new_status === 'TP1 HIT')) return res.json({ success: true });
        if (trade.status === 'TP2 HIT' && new_status === 'TP1 HIT') return res.json({ success: true });

        // Check if status is same (duplicate check)
        if (trade.status === new_status) return res.json({ success: true }); 

        let points = calculatePoints(trade.type, trade.entry_price, price);
        
        await pool.query("UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3", [new_status, points, trade_id]);

        // ✅ FIXED: Clean Markdown Message
        const msg = `⚡ *UPDATE: ${toMarkdown(new_status)}*

💎 *Symbol:* #${toMarkdown(trade.symbol)}
📉 *Price:* ${toMarkdown(price)}`;
        
        const opts = { parse_mode: 'Markdown' };
        if (trade.telegram_msg_id) opts.reply_to_message_id = trade.telegram_msg_id;

        await bot.sendMessage(CHAT_ID, msg, opts);
        
        io.emit('trade_update'); 
        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DELETE ENDPOINT ---
app.post('/api/delete_trades', async (req, res) => {
    const { trade_ids, password } = req.body; 
    
    if (password !== DELETE_PASSWORD) {
        return res.status(401).json({ success: false, msg: "❌ Incorrect Password!" });
    }

    if (!trade_ids || !Array.isArray(trade_ids) || trade_ids.length === 0) {
        return res.status(400).json({ success: false, msg: "No IDs provided" });
    }

    try {
        const query = "DELETE FROM trades WHERE trade_id = ANY($1)";
        await pool.query(query, [trade_ids]);
        
        io.emit('trade_update'); 
        res.json({ success: true });
    } catch (err) { 
        console.error(err); 
        res.status(500).json({ error: err.message }); 
    }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
    server.listen(PORT, () => console.log(`🚀 RD Broker Server running on ${PORT}`));
});
