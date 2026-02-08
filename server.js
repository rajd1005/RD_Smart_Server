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

// --- 1. SIGNAL DETECTED (Arrow) ---
app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type } = req.body;
    const istTime = getISTTime();

    try {
        const msg = `⚠️ **NEW SIGNAL**\nSymbol: ${symbol}\nType: ${type}\nTime: ${istTime}`;

        // Send Telegram Message ONE time and capture the ID
        bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' }).then(sent => {
             const query = `
                INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status)
                VALUES ($1, $2, $3, $4, $5, 'SIGNAL')
                ON CONFLICT (trade_id) DO NOTHING;
             `;
             pool.query(query, [trade_id, symbol, type, sent.message_id, istTime]);
        }).catch(err => console.error("Telegram Error:", err));

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. SETUP CONFIRMED (Entry/SL/TP) + FORCE CLOSE LOGIC ---
app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3, current_ltp } = req.body;
    const istTime = getISTTime();

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

        // --- STEP B: UPSERT NEW TRADE (Insert or Update if exists) ---
        // This fixes the "Race Condition" where Setup arrives before Signal is saved.
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
                status = 'SETUP'
            RETURNING telegram_msg_id;
        `;

        const result = await pool.query(query, [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, istTime]);
        const telegram_msg_id = result.rows[0]?.telegram_msg_id;

        const msg = `📋 **SETUP CONFIRMED**\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
        
        // Reply to original signal if it exists, otherwise send as new message
        const opts = { parse_mode: 'Markdown' };
        if(telegram_msg_id) opts.reply_to_message_id = telegram_msg_id;
        
        bot.sendMessage(CHAT_ID, msg, opts);

        res.json({ success: true });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. PRICE UPDATE (THE BRAIN) ---
app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    
    try {
        // FIX 1: Updated SQL to include 'HIT' statuses. 
        // Previously, the server stopped tracking trades after TP1 because 'TP1 HIT' wasn't in the list.
        const trades = await pool.query(
            "SELECT * FROM trades WHERE symbol = $1 AND status IN ('SETUP', 'ACTIVE', 'TP1 HIT', 'TP2 HIT')",
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
                    const opts = { parse_mode: 'Markdown' };
                    if(t.telegram_msg_id) opts.reply_to_message_id = t.telegram_msg_id;
                    
                    bot.sendMessage(CHAT_ID, `🚀 **ENTRY ACTIVATED**\n${t.symbol} @ ${price}`, opts);
                }
            }

            // 2. CHECK TP/SL (If Active)
            if (t.status === 'ACTIVE' || t.status.includes('TP')) {
                
                // Determine Current Status Level to prevent "Flickering" (Downgrading)
                let currentLevel = 0;
                if (t.status.includes('TP1')) currentLevel = 1;
                if (t.status.includes('TP2')) currentLevel = 2;
                if (t.status.includes('TP3')) currentLevel = 3;

                // STOP LOSS CHECK
                // (Optional: You can add logic here to ignore SL if currentLevel > 0 to Lock Profit)
                let slHit = (t.type === 'BUY' && price <= t.sl_price) || (t.type === 'SELL' && price >= t.sl_price);
                
                if (slHit && currentLevel === 0) {
                    newStatus = 'SL HIT';
                }

                // TP CHECK (Lock Profit)
                let tp1Hit = (t.type === 'BUY' && price >= t.tp1_price) || (t.type === 'SELL' && price <= t.tp1_price);
                let tp2Hit = (t.type === 'BUY' && price >= t.tp2_price) || (t.type === 'SELL' && price <= t.tp2_price);
                let tp3Hit = (t.type === 'BUY' && price >= t.tp3_price) || (t.type === 'SELL' && price <= t.tp3_price);

                // FIX 2: Strict Priority Logic (Only Upgrade, Never Downgrade)
                if (tp3Hit && currentLevel < 3) {
                    newStatus = 'TP3 HIT';
                } 
                else if (tp2Hit && currentLevel < 2 && newStatus !== 'TP3 HIT') {
                    newStatus = 'TP2 HIT';
                } 
                else if (tp1Hit && currentLevel < 1 && newStatus !== 'TP2 HIT' && newStatus !== 'TP3 HIT') {
                    newStatus = 'TP1 HIT';
                }
            }

            // 3. UPDATE DB IF CHANGED
            if (newStatus !== t.status) {
                
                if (newStatus.includes('TP')) {
                    [cite_start]// Lock points at the Target Price level [cite: 10]
                    let targetPrice = (newStatus === 'TP1 HIT') ? t.tp1_price : (newStatus === 'TP2 HIT') ? t.tp2_price : t.tp3_price;
                    points = calculatePoints(t.type, t.entry_price, targetPrice);
                }

                await pool.query(
                    "UPDATE trades SET status = $1, points_gained = $2 WHERE id = $3",
                    [newStatus, points, t.id]
                );
                
                if (newStatus.includes('HIT')) {
                    const opts = { parse_mode: 'Markdown' };
                    if(t.telegram_msg_id) opts.reply_to_message_id = t.telegram_msg_id;
                    bot.sendMessage(CHAT_ID, `🎯 **${newStatus}**\n${t.symbol}\nLocked Points: ${points.toFixed(5)}`, opts);
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
