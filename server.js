const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto'); 
const { pool, initDb } = require('./database');
const authPool = require('./authDb'); 
require('dotenv').config();

const app = express();

app.set('trust proxy', true); 

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// --- CONFIG ---
const DELETE_PASSWORD = (process.env.DELETE_PASSWORD || "admin123").trim(); 
const JWT_SECRET = (process.env.JWT_SECRET || "super_secret_key_123").trim();

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@rdalgo.in").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "admin123").trim();

console.log("\n====================================");
console.log("🔧 ENVIRONMENT VARIABLE CHECK:");
console.log(`- Admin Email: ${ADMIN_EMAIL}`);
console.log(`- Custom ADMIN_PASSWORD found in Railway: ${process.env.ADMIN_PASSWORD ? "✅ YES" : "❌ NO (Using Default admin123)"}`);
console.log(`- Custom DELETE_PASSWORD found in Railway: ${process.env.DELETE_PASSWORD ? "✅ YES" : "❌ NO (Using Default admin123)"}`);
console.log("====================================\n");

function getClientIp(req) {
    let ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '';
    if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0]; 
    return ip.trim().replace('::ffff:', '');
}

const authenticateToken = async (req, res, next) => {
    const token = req.cookies.authToken;
    if (!token) return res.status(401).json({ success: false, msg: "Not authenticated" });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const currentIp = getClientIp(req);

        if (decoded.ip !== currentIp) {
            res.clearCookie('authToken');
            return res.status(403).json({ success: false, msg: "IP changed. Please login again." });
        }

        const { rows } = await pool.query(
            "SELECT session_id FROM login_logs WHERE email = $1 ORDER BY login_time DESC LIMIT 1", 
            [decoded.email]
        );

        if (rows.length > 0 && rows[0].session_id !== decoded.sessionId) {
            res.clearCookie('authToken');
            return res.status(403).json({ success: false, msg: "Logged in from another device. Session expired." });
        }
        
        req.user = decoded;
        next();
    } catch (err) {
        res.clearCookie('authToken');
        return res.status(403).json({ success: false, msg: "Session expired" });
    }
};

app.use(async (req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') {
        const token = req.cookies.authToken;
        if (!token) return res.redirect('/login.html');

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const currentIp = getClientIp(req);

            if (decoded.ip !== currentIp) {
                res.clearCookie('authToken');
                return res.redirect('/login.html');
            }

            const { rows } = await pool.query(
                "SELECT session_id FROM login_logs WHERE email = $1 ORDER BY login_time DESC LIMIT 1", 
                [decoded.email]
            );

            if (rows.length > 0 && rows[0].session_id !== decoded.sessionId) {
                res.clearCookie('authToken');
                return res.redirect('/login.html');
            }
            
            next(); 
        } catch (err) {
            res.clearCookie('authToken');
            return res.redirect('/login.html');
        }
    } else {
        next(); 
    }
});

app.use(express.static(path.join(__dirname, 'public'))); 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", credentials: true } });
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

function getISTTime() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }); }
function getDBTime() { return new Date().toISOString(); }
function calculatePoints(type, entry, currentPrice) {
    if (!entry || !currentPrice) return 0;
    return (type === 'BUY') ? (currentPrice - entry) : (entry - currentPrice);
}
function toMarkdown(text) {
    if (text === undefined || text === null) return "";
    return String(text).replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/\[/g, "\\[").replace(/`/g, "\\`"); 
}

app.post('/api/login', async (req, res) => {
    const { email, password, rememberMe } = req.body;
    const clientIp = getClientIp(req);
    
    try {
        let userEmail = "";
        let userRole = "student";

        if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
            userEmail = ADMIN_EMAIL;
            userRole = "admin";
        } else {
            const [rows] = await authPool.query(
                "SELECT * FROM wp_gf_student_registrations WHERE student_email = ? AND student_phone = ?",
                [email, password]
            );

            if (rows.length === 0) return res.status(401).json({ success: false, msg: "Invalid Email or Password" });

            const student = rows[0];
            const expiryDate = new Date(student.student_expiry_date);
            if (expiryDate < new Date()) return res.status(403).json({ success: false, msg: "Account Expired. Please contact admin." });

            userEmail = student.student_email;
        }

        const sessionId = crypto.randomUUID();
        await pool.query(
            "INSERT INTO login_logs (email, session_id, ip_address) VALUES ($1, $2, $3)", 
            [userEmail, sessionId, clientIp]
        );
        await pool.query("DELETE FROM login_logs WHERE login_time < NOW() - INTERVAL '30 days'");

        const token = jwt.sign(
            { email: userEmail, ip: clientIp, sessionId: sessionId, role: userRole }, 
            JWT_SECRET, 
            { expiresIn: rememberMe ? '30d' : '1d' } 
        );

        res.cookie('authToken', token, {
            httpOnly: true, 
            secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
            sameSite: 'lax',
            maxAge: rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000 
        });

        // ✅ FIXED: Now sending the role back to the browser so the UI knows if you are an admin
        res.json({ success: true, msg: "Login successful", role: userRole });
    } catch (error) {
        res.status(500).json({ success: false, msg: "Database connection error" });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('authToken');
    res.json({ success: true });
});

app.get('/api/trades', authenticateToken, async (req, res) => {
    try {
        const query = "SELECT * FROM trades WHERE CAST(created_at AS TIMESTAMP) >= NOW() - INTERVAL '30 days' ORDER BY id DESC";
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/signal_detected', async (req, res) => {
    const { trade_id, symbol, type } = req.body;
    try {
        const msg = `🚨 *NEW SIGNAL DETECTED*\n\n💎 *Symbol:* #${toMarkdown(symbol)}\n📊 *Type:* ${toMarkdown(type)}\n🕒 *Time:* ${toMarkdown(getISTTime())}`;
        const sentMsg = await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        
        await pool.query(
            "INSERT INTO trades (trade_id, symbol, type, telegram_msg_id, created_at, status) VALUES ($1, $2, $3, $4, $5, 'SIGNAL') ON CONFLICT (trade_id) DO NOTHING;",
            [trade_id, symbol, type, sentMsg.message_id, getDBTime()]
        );
        await pool.query("DELETE FROM trades WHERE CAST(created_at AS TIMESTAMP) < NOW() - INTERVAL '30 days'");

        io.emit('trade_update'); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/setup_confirmed', async (req, res) => {
    const { trade_id, symbol, type, entry, sl, tp1, tp2, tp3 } = req.body;
    try {
        const oldTrades = await pool.query("SELECT * FROM trades WHERE symbol = $1 AND status IN ('SIGNAL', 'SETUP', 'ACTIVE') AND trade_id != $2", [symbol, trade_id]);
        for (const t of oldTrades.rows) {
            await pool.query("UPDATE trades SET status = 'CLOSED (Reversal)' WHERE trade_id = $1", [t.trade_id]);
            if(t.telegram_msg_id) bot.sendMessage(CHAT_ID, `🔄 *Trade Reversed*\n❌ Closed by new signal.`, { reply_to_message_id: t.telegram_msg_id, parse_mode: 'Markdown' });
        }

        const check = await pool.query("SELECT telegram_msg_id FROM trades WHERE trade_id = $1", [trade_id]);
        
        await pool.query(
            "INSERT INTO trades (trade_id, symbol, type, entry_price, sl_price, tp1_price, tp2_price, tp3_price, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SETUP', $9) ON CONFLICT (trade_id) DO UPDATE SET entry_price = EXCLUDED.entry_price, sl_price = EXCLUDED.sl_price, tp1_price = EXCLUDED.tp1_price, tp2_price = EXCLUDED.tp2_price, tp3_price = EXCLUDED.tp3_price, status = 'SETUP';",
            [trade_id, symbol, type, entry, sl, tp1, tp2, tp3, getDBTime()]
        );

        const msg = `✅ *SETUP CONFIRMED*\n\n💎 *Symbol:* #${toMarkdown(symbol)}\n🚀 *Type:* ${toMarkdown(type)}\n🚪 *Entry:* ${toMarkdown(entry)}\n🛑 *SL:* ${toMarkdown(sl)}\n\n🎯 *TP1:* ${toMarkdown(tp1)}\n🎯 *TP2:* ${toMarkdown(tp2)}\n🎯 *TP3:* ${toMarkdown(tp3)}`;
        const opts = { parse_mode: 'Markdown' };
        if (check.rows[0]?.telegram_msg_id) opts.reply_to_message_id = check.rows[0].telegram_msg_id;

        await bot.sendMessage(CHAT_ID, msg, opts);
        io.emit('trade_update'); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/price_update', async (req, res) => {
    const { symbol, bid, ask } = req.body;
    try {
        const trades = await pool.query("SELECT * FROM trades WHERE symbol = $1 AND status = 'ACTIVE'", [symbol]);
        for (const t of trades.rows) {
            let currentPrice = (t.type === 'BUY') ? bid : ask;
            await pool.query("UPDATE trades SET points_gained = $1 WHERE id = $2", [calculatePoints(t.type, t.entry_price, currentPrice), t.id]);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/log_event', async (req, res) => {
    const { trade_id, new_status, price } = req.body;
    try {
        const result = await pool.query("SELECT * FROM trades WHERE trade_id = $1", [trade_id]);
        if (result.rows.length === 0) return res.json({ success: false, msg: "Trade not found" });

        const trade = result.rows[0];
        if (trade.status.includes('TP') && new_status === 'SL HIT') return res.json({ success: true, msg: "Profit Locked: SL Ignored" });
        if (trade.status === 'TP3 HIT' && (new_status === 'TP2 HIT' || new_status === 'TP1 HIT')) return res.json({ success: true });
        if (trade.status === 'TP2 HIT' && new_status === 'TP1 HIT') return res.json({ success: true });
        if (trade.status === new_status) return res.json({ success: true }); 

        await pool.query("UPDATE trades SET status = $1, points_gained = $2 WHERE trade_id = $3", [new_status, calculatePoints(trade.type, trade.entry_price, price), trade_id]);

        const opts = { parse_mode: 'Markdown' };
        if (trade.telegram_msg_id) opts.reply_to_message_id = trade.telegram_msg_id;

        await bot.sendMessage(CHAT_ID, `⚡ *UPDATE: ${toMarkdown(new_status)}*\n\n💎 *Symbol:* #${toMarkdown(trade.symbol)}\n📉 *Price:* ${toMarkdown(price)}`, opts);
        io.emit('trade_update'); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/delete_trades', authenticateToken, async (req, res) => {
    const { trade_ids, password } = req.body; 
    if (password !== DELETE_PASSWORD) return res.status(401).json({ success: false, msg: "❌ Incorrect Password!" });
    if (!trade_ids || trade_ids.length === 0) return res.status(400).json({ success: false, msg: "No IDs provided" });

    try {
        await pool.query("DELETE FROM trades WHERE trade_id = ANY($1)", [trade_ids]);
        io.emit('trade_update'); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
    server.listen(PORT, () => console.log(`🚀 RD Broker Server running on ${PORT}`));
});
