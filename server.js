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

function getISTTime() {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// Helper: Calculate Points for Profit Display
function calculatePoints(type, entry, currentPrice) {
    if (!entry || !currentPrice) return 0;
    let raw = (type === 'BUY') ? (currentPrice - entry) : (entry - currentPrice);
    // Multiplier for Forex pairs (usually 10000 or 100 for JPY) to show 'Pips'
    // For generic points, we just return the raw difference
    return raw; 
}

// --- 1. SIGNAL DETECTED (Start of Thread) ---
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type } = req.body;
    const istTime = getISTTime();

    try {
        const msg = `⚠️ **NEW SIGNAL**\nSymbol: ${symbol}\nType: ${type}\nTime: ${istTime}`;

        // Send New Message
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        
        // Save to DB with Message ID
        const query = `
            INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status)
            VALUES ($1, $2, $3, $4, $5, 'SIGNAL')
            ON CONFLICT (trade_id) DO NOTHING;
        `;
        await pool.query(query, [trade_id, symbol, type, sentMsg.message_id, istTime]);

        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// --- 2. SETUP CONFIRMED (Reply to Signal) ---
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3 } = req.body;
    const istTime = getISTTime();

    try {
        // 1. Force Close Old Trades (Reverse Logic)
        const oldTrades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SIGNAL', 'SETUP', 'ACTIVE') AND trade_id != $2",
            [symbol, trade_id]
        );
        
        for (const t of oldTrades.rows) {
            await pool.query("UPDATE trades SET status = 'CLOSED (Reversal)' WHERE trade_id = $1", [t.trade_id]);
            // Reply to the OLD trade thread that it is closed
            if(t.telegram_msg_id) {
                bot.sendMessage(CHAT_ID, `🔄 **Trade Reversed**\nClosed by new signal.`, { reply_to_message_id: t.telegram_msg_id });
            }
        }

        // 2. Update Current Trade
        // We fetch the existing trade to get the telegram_msg_id
        const check = await pool.query("SELECT telegram_msg_id FROM trades WHERE trade_id = $1", [trade_id]);
        let msgId = check.rows[0]?.telegram_msg_id;

        const query = `
            INSERT INTO trades (trade_id, symbol, type, entry_price, sl_price, tp1_price, tp2_price, tp3_price, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SETUP', $9)
            ON CONFLICT (trade_id) 
            DO UPDATE SET 
                entry_price = EXCLUDED.entry_price,
                sl_price = EXCLUDED.sl_price,
                tp1_price = EXCLUDED.tp1_price,
                tp2_price = EXCLUDED.tp2_price,
                tp3_price = EXCLUDED.tp3_price,
                status = 'SETUP';
        `;
        await pool.query(query, [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, istTime]);

        // 3. Send Telegram Reply
        const msg = `📋 **SETUP CONFIRMED**\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
        const opts = { parse_mode: 'Markdown' };
        if (msgId) opts.reply_to_message_id = msgId;

        await bot.sendMessage(CHAT_ID, msg, opts);
        res.json({ success: true });

    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// --- 3. PRICE UPDATE (DUMB MODE - ONLY UPDATES DB) ---
app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    try {
        // Only update "Active" trades so the web dashboard shows floating P/L.
        // WE DO NOT CHECK TP/SL HERE. MT4 IS MASTER.
        const trades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status = 'ACTIVE'",
            [symbol]
        );

        for (const t of trades.rows) {
            let currentPrice = (t.type === 'BUY') ? bid : ask;
            let points = calculatePoints(t.type, t.entry_price, currentPrice);
            
            await pool.query(
                "UPDATE trades SET points_gained = $1 WHERE id = $2",
                [points, t.id]
            );
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. INSTANT EVENT LOGGER (MASTER UPDATE FROM MT4) ---
app.post('/api/log_event', async (req, res) => {
    const { trade_id, new_status, price } = req.body;
    
    try {
        // 1. Get current trade
        const result = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (result.rows.length === 0) return res.json({ success: false, msg: "Trade not found" });

        const trade = result.rows[0];
        
        // Prevent duplicate updates (e.g., if MT4 sends "TP1 HIT" twice in a row)
        if (trade.status === new_status) return res.json({ success: true });

        // Calculate Locked Points
        let points = calculatePoints(trade.type, trade.entry_price, price);
        
        // Update DB
        await pool.query(
            "UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3",
            [new_status, points, trade_id]
        );

        // Send Telegram Reply
        const msg = `⚡ **UPDATE: ${new_status}**\nPrice: ${price}\nProfit: ${points.toFixed(5)}`;
        const opts = { parse_mode: 'Markdown' };
        if (trade.telegram_msg_id) opts.reply_to_message_id = trade.telegram_msg_id;

        await bot.sendMessage(CHAT_ID, msg, opts);
        console.log(`⚡ Instant Update: ${trade.symbol} -> ${new_status}`);

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
    app.listen(PORT, () => console.log(`🚀 Trade Manager (Passive Mode) running on ${PORT}`));
});
