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
    // Standardizing points (Optional: You can adjust this multiplier if needed)
    return raw; 
}

// --- 1. SIGNAL DETECTED (Arrow) ---
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type } = req.body;
    const istTime = getISTTime();

    try {
        const msg = `⚠️ **NEW SIGNAL**\nSymbol: ${symbol}\nType: ${type}\nTime: ${istTime}`;
        bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });

        // Insert Signal (Status: SIGNAL)
        const query = `
            INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status)
            VALUES ($1, $2, $3, $4, $5, 'SIGNAL')
            ON CONFLICT (trade_id) DO NOTHING;
        `;
        // We catch the message ID in a variable to avoid blocking response
        bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' }).then(sent => {
             pool.query(query, [trade_id, symbol, type, sent.message_id, istTime]);
        });

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. SETUP CONFIRMED (Entry/SL/TP) + FORCE CLOSE LOGIC ---
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3, current_ltp } = req.body;

    try {
        // --- STEP A: FORCE CLOSE OLD TRADES ---
        // Find any OPEN trade for this Symbol that is NOT the current new one
        const oldTrades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SIGNAL', 'SETUP', 'ACTIVE', 'TP1', 'TP2') AND trade_id != $2",
            [symbol, trade_id]
        );

        for (const oldTrade of oldTrades.rows) {
            let closeStatus = "CLOSED (Reversal)";
            let finalPoints = 0;

            if (oldTrade.status === 'SIGNAL' || oldTrade.status === 'SETUP') {
                closeStatus = "EXPIRED"; // Pending trade never triggered
                finalPoints = 0;
            } 
            else if (oldTrade.status.includes('TP')) {
                // Profit ALREADY Locked at TP. Do not recalculate.
                closeStatus = `CLOSED (${oldTrade.status})`;
                finalPoints = oldTrade.points_gained; 
            } 
            else if (oldTrade.status === 'ACTIVE') {
                // Floating Trade: Calculate P/L at this exact moment
                finalPoints = calculatePoints(oldTrade.type, oldTrade.entry_price, current_ltp);
                closeStatus = "CLOSED (Force)";
            }

            // Close the Old Trade
            await pool.query(
                "UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3",
                [closeStatus, finalPoints, oldTrade.trade_id]
            );
            
            bot.sendMessage(CHAT_ID, `🔄 **SWITCHING SIDES**\n${symbol} Old Trade Closed\nResult: ${finalPoints.toFixed(5)}`);
        }

        // --- STEP B: UPDATE NEW TRADE ---
        const lookup = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (lookup.rows.length === 0) return res.status(404).json({ error: "Signal not found" });
        const trade = lookup.rows[0];

        await pool.query(
            "UPDATE trades SET entry_price=$1, sl_price=$2, tp1_price=$3, tp2_price=$4, tp3_price=$5, status='SETUP' WHERE trade_id=$6",
            [entry, sl, tp1, tp2, tp3, trade_id]
        );

        const msg = `📋 **SETUP CONFIRMED**\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
        bot.sendMessage(CHAT_ID, msg, { reply_to_message_id: trade.telegram_msg_id, parse_mode: 'Markdown' });

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. PRICE UPDATE (THE BRAIN) ---
app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    // NOTE: For Buy trade, we check Bid for TP, Ask for SL (simplified to Bid for now for speed)
    // Best practice: Buy Exit = Bid, Sell Exit = Ask.
    
    try {
        // Get all OPEN trades for this symbol
        const trades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SETUP', 'ACTIVE', 'TP1', 'TP2')",
            [symbol]
        );

        for (const t of trades.rows) {
            let newStatus = t.status;
            let price = (t.type === 'BUY') ? bid : ask; // Current price relevant to trade
            let points = calculatePoints(t.type, t.entry_price, price);

            // 1. CHECK ENTRY (If Pending)
            if (t.status === 'SETUP') {
                let hit = (t.type === 'BUY' && price >= t.entry_price) || (t.type === 'SELL' && price <= t.entry_price);
                if (hit) {
                    newStatus = 'ACTIVE';
                    bot.sendMessage(CHAT_ID, `🚀 **ENTRY ACTIVATED**\n${t.symbol} @ ${price}`, { reply_to_message_id: t.telegram_msg_id, parse_mode: 'Markdown' });
                }
            }

            // 2. CHECK TP/SL (If Active)
            if (t.status === 'ACTIVE' || t.status.includes('TP')) {
                
                // STOP LOSS CHECK
                let slHit = (t.type === 'BUY' && price <= t.sl_price) || (t.type === 'SELL' && price >= t.sl_price);
                if (slHit) {
                    newStatus = 'SL HIT';
                    // Final SL points are fixed distance (Entry - SL) usually, or actual close.
                    // Let's use actual close for accuracy.
                }

                // TP CHECK (Lock Profit)
                // We only upgrade status. TP1 -> TP2. Never TP2 -> TP1.
                let tp1Hit = (t.type === 'BUY' && price >= t.tp1_price) || (t.type === 'SELL' && price <= t.tp1_price);
                let tp2Hit = (t.type === 'BUY' && price >= t.tp2_price) || (t.type === 'SELL' && price <= t.tp2_price);
                let tp3Hit = (t.type === 'BUY' && price >= t.tp3_price) || (t.type === 'SELL' && price <= t.tp3_price);

                if (tp3Hit) newStatus = 'TP3 HIT';
                else if (tp2Hit && newStatus !== 'TP3 HIT') newStatus = 'TP2 HIT';
                else if (tp1Hit && newStatus !== 'TP2 HIT' && newStatus !== 'TP3 HIT') newStatus = 'TP1 HIT';
            }

            // 3. UPDATE DB IF CHANGED
            if (newStatus !== t.status) {
                // If TP/SL hit, we update the points to "Lock" them at that level? 
                // Or do we keep updating points live? 
                // User said: "Profit should lock every TP".
                
                if (newStatus.includes('TP')) {
                    // Lock points at the Target Price level, not current price
                    let targetPrice = (newStatus === 'TP1 HIT') ? t.tp1_price : (newStatus === 'TP2 HIT') ? t.tp2_price : t.tp3_price;
                    points = calculatePoints(t.type, t.entry_price, targetPrice);
                }

                await pool.query(
                    "UPDATE trades SET status = $1, points_gained = $2 WHERE id = $3",
                    [newStatus, points, t.id]
                );
                
                if (newStatus.includes('HIT')) {
                     bot.sendMessage(CHAT_ID, `🎯 **${newStatus}**\n${t.symbol}\nLocked Points: ${points.toFixed(5)}`, { reply_to_message_id: t.telegram_msg_id, parse_mode: 'Markdown' });
                }
            } 
            else if (t.status === 'ACTIVE') {
                // Just update floating points live without changing status
                await pool.query("UPDATE trades SET points_gained = $1 WHERE id = $2", [points, t.id]);
            }
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
