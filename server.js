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

// HELPER: IST Time
function getISTTime() {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// HELPER: Calculate Points
function calculatePoints(type, entry, close) {
    let raw = (type === 'BUY') ? (close - entry) : (entry - close);
    return raw; 
}

// --- 1. SIGNAL DETECTED (SILENT MODE) ---
// Action: Save to DB only. No Telegram Message.
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type, time } = req.body;
    
    // We use the 'time' sent from MT4 (Breakout Time) as the creation time
    // If not provided, fallback to current IST
    const createdTime = time ? time : getISTTime();

    try {
        const query = `
            INSERT INTO trades (trade_id, symbol, type, created_at, status)
            VALUES ($1, $2, $3, $4, 'SIGNAL')
            ON CONFLICT (trade_id) DO NOTHING;
        `;
        await pool.query(query, [trade_id, symbol, type, createdTime]);
        
        console.log(`[SILENT] New Signal Saved: ${trade_id}`);
        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

// --- 2. SETUP CONFIRMED (THE PARENT MESSAGE) ---
// Action: Send "Setup Confirmed" Msg -> Save msg_id for Threading
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3, current_ltp } = req.body;

    try {
        // --- STEP A: FORCE CLOSE OLD TRADES ---
        const oldTrades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SIGNAL', 'SETUP', 'ACTIVE', 'TP1', 'TP2') AND trade_id != $2",
            [symbol, trade_id]
        );

        for (const oldTrade of oldTrades.rows) {
            let closeStatus = "CLOSED (Reversal)";
            let finalPoints = 0;

            if (oldTrade.status === 'SIGNAL' || oldTrade.status === 'SETUP') {
                closeStatus = "EXPIRED"; 
                finalPoints = 0;
            } 
            else if (oldTrade.status.includes('TP') || oldTrade.status.includes('SL')) {
                closeStatus = `CLOSED (${oldTrade.status})`;
                finalPoints = oldTrade.points_gained; 
            } 
            else if (oldTrade.status === 'ACTIVE') {
                finalPoints = calculatePoints(oldTrade.type, oldTrade.entry_price, current_ltp);
                closeStatus = "CLOSED (Force)";
            }

            await pool.query(
                "UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3",
                [closeStatus, finalPoints, oldTrade.trade_id]
            );
            
            // Notify closure (Optional: Can be silent or a reply to the old thread)
            if(oldTrade.telegram_msg_id) {
                 bot.sendMessage(CHAT_ID, `🔄 **SWITCHING SIDES**\nOld Trade Closed. Result: ${finalPoints.toFixed(5)}`, { reply_to_message_id: oldTrade.telegram_msg_id, parse_mode: 'Markdown' });
            }
        }

        // --- STEP B: UPDATE NEW TRADE & START THREAD ---
        const msg = `📋 **SETUP CONFIRMED**\n\n**${symbol}** (${type})\nEntry: ${entry}\nSL: ${sl}\n\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
        
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        
        // Update DB with Setup Info + THE IMPORTANT MESSAGE ID
        await pool.query(
            "UPDATE trades SET entry_price=$1, sl_price=$2, tp1_price=$3, tp2_price=$4, tp3_price=$5, status='SETUP', telegram_msg_id=$6 WHERE trade_id=$7",
            [entry, sl, tp1, tp2, tp3, sentMsg.message_id, trade_id]
        );

        res.json({ success: true });

    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

// --- 3. NEW: TRADE EVENT HANDLER (TICK BASED) ---
// Action: Receives Instant "HIT" events from MT4 and Replies to Thread
app.post('/api/trade_event', async (req, res) => {
    const { trade_id, event, price } = req.body; 
    // event types: "ENTRY_HIT", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_HIT"

    try {
        // 1. Get Trade Info
        const result = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Trade not found" });
        
        const t = result.rows[0];
        let newStatus = t.status;
        let replyMsg = "";
        let points = t.points_gained;

        // 2. Logic Per Event
        if (event === "ENTRY_HIT" && t.status === "SETUP") {
            newStatus = "ACTIVE";
            replyMsg = `🚀 **ENTRY TRIGGERED**\nPrice: ${price}`;
        }
        else if (event === "TP1_HIT" && !t.status.includes("TP")) {
            newStatus = "TP1 HIT";
            points = calculatePoints(t.type, t.entry_price, t.tp1_price);
            replyMsg = `✅ **TARGET 1 HIT**\nPrice: ${price}\nLocked: ${points.toFixed(5)}`;
        }
        else if (event === "TP2_HIT" && t.status !== "TP2 HIT" && t.status !== "TP3 HIT") {
            newStatus = "TP2 HIT";
            points = calculatePoints(t.type, t.entry_price, t.tp2_price);
            replyMsg = `✅ **TARGET 2 HIT**\nPrice: ${price}\nLocked: ${points.toFixed(5)}`;
        }
        else if (event === "TP3_HIT" && t.status !== "TP3 HIT") {
            newStatus = "TP3 HIT";
            points = calculatePoints(t.type, t.entry_price, t.tp3_price);
            replyMsg = `🥂 **TARGET 3 HIT (MAX)**\nPrice: ${price}\nLocked: ${points.toFixed(5)}`;
        }
        else if (event === "SL_HIT" && !t.status.includes("HIT")) {
            newStatus = "SL HIT";
            points = calculatePoints(t.type, t.entry_price, t.sl_price);
            replyMsg = `🛑 **STOP LOSS HIT**\nPrice: ${price}\nLoss: ${points.toFixed(5)}`;
        }

        // 3. Update & Reply (Only if status changed)
        if (newStatus !== t.status) {
            await pool.query(
                "UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3",
                [newStatus, points, trade_id]
            );

            if (t.telegram_msg_id && replyMsg !== "") {
                bot.sendMessage(CHAT_ID, replyMsg, { 
                    reply_to_message_id: t.telegram_msg_id, 
                    parse_mode: 'Markdown' 
                });
            }
        }

        res.json({ success: true, status: newStatus });

    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: err.message }); 
    }
});

// --- 4. PRICE UPDATE (HEARTBEAT ONLY) ---
// Action: Only updates Web Dashboard. No Telegram Alerts (MT4 handles alerts now).
app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    
    try {
        // Just update floating P/L for ACTIVE trades for the dashboard
        const trades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status = 'ACTIVE'", 
            [symbol]
        );

        for (const t of trades.rows) {
            let price = (t.type === 'BUY') ? bid : ask; 
            let points = calculatePoints(t.type, t.entry_price, price);
            
            await pool.query("UPDATE trades SET points_gained = $1 WHERE id = $2", [points, t.id]);
        }
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trades', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM trades ORDER BY id DESC LIMIT 100");
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
    app.listen(PORT, () => console.log(`🚀 Trade Manager running on ${PORT}`));
});
