const API_URL = '/api/trades'; 
let allTrades = []; 
let isSelectionMode = false;
const socket = io(); 

window.onload = function() {
    setTodayDate();
    fetchTrades();
};

socket.on('trade_update', () => { fetchTrades(); });

function setTodayDate() {
    const istDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    document.getElementById('filterDate').value = istDate;
}

async function fetchTrades() {
    const checkedIds = getCheckedIds();
    try {
        const response = await fetch(API_URL);
        allTrades = await response.json();
        applyFilters(checkedIds); 
    } catch (error) { console.error(error); }
}

function applyFilters(preserveIds = []) {
    const filterSymbol = document.getElementById('filterSymbol').value.toUpperCase();
    const filterStatus = document.getElementById('filterStatus').value;
    const filterType = document.getElementById('filterType').value;
    const filterDateInput = document.getElementById('filterDate').value; 

    const filtered = allTrades.filter(trade => {
        const tradeDateObj = new Date(trade.created_at);
        const tradeDateStr = tradeDateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        return ((filterDateInput === "") || (tradeDateStr === filterDateInput)) &&
               (trade.symbol.includes(filterSymbol)) &&
               (filterType === 'ALL' || trade.type === filterType) &&
               (filterStatus === 'ALL' || 
               (filterStatus === 'TP' && trade.status.includes('TP')) ||
               (filterStatus === 'SL' && trade.status.includes('SL')) ||
               (filterStatus === 'OPEN' && trade.status === 'ACTIVE'));
    });

    renderTrades(filtered, preserveIds);
    calculateStats(filtered);
}

// --- ULTRA COMPACT RENDERER ---
function renderTrades(trades, preserveIds) {
    const container = document.getElementById('tradeListContainer');
    const noDataMsg = document.getElementById('noData');
    
    container.innerHTML = '';
    
    if (trades.length === 0) {
        if(noDataMsg) noDataMsg.style.display = 'block';
        return;
    } else {
        if(noDataMsg) noDataMsg.style.display = 'none';
    }

    trades.forEach((trade) => {
        const dateObj = new Date(trade.created_at);
        const timeString = dateObj.toLocaleTimeString('en-US', { 
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false 
        });

        // 2 Decimal Logic Everywhere
        const entry = parseFloat(trade.entry_price).toFixed(2);
        const sl = parseFloat(trade.sl_price).toFixed(2);
        const tp1 = parseFloat(trade.tp1_price).toFixed(2);
        const tp2 = parseFloat(trade.tp2_price).toFixed(2);
        const tp3 = parseFloat(trade.tp3_price).toFixed(2);
        const pts = parseFloat(trade.points_gained);
        const displayPts = pts.toFixed(2);

        // Styling
        let profitColor = 'text-muted';
        let statusColor = '#878a8d';
        let statusText = trade.status.replace(' (Reversal)', '');
        
        if (trade.status === 'ACTIVE') { statusColor = '#007aff'; }
        else if (trade.status.includes('TP')) { statusColor = '#00b346'; profitColor = 'c-green'; }
        else if (trade.status.includes('SL')) { statusColor = '#ff3b30'; profitColor = 'c-red'; }
        else if (pts > 0) { profitColor = 'c-green'; }
        else if (pts < 0) { profitColor = 'c-red'; }

        const badgeClass = trade.type === 'BUY' ? 'bg-buy' : 'bg-sell';
        const isChecked = preserveIds.includes(trade.trade_id) ? 'checked' : '';
        const checkDisplay = isSelectionMode ? 'block' : 'none';

        const html = `
            <div class="trade-card">
                <div class="tc-top">
                    <div class="d-flex align-items-center">
                        <input type="checkbox" class="custom-check trade-checkbox" value="${trade.trade_id}" ${isChecked} style="display:${checkDisplay}">
                        <div class="tc-symbol">${trade.symbol}</div>
                    </div>
                    <div class="tc-profit ${profitColor}">${pts > 0 ? '+' : ''}${displayPts}</div>
                </div>

                <div class="tc-mid">
                    <span class="type-badge ${badgeClass}">${trade.type}</span>
                    <span class="tc-time">${timeString}</span>
                    <span class="status-txt ms-auto" style="color:${statusColor}">${statusText}</span>
                </div>

                <div class="tc-bot">
                    <div class="dt-item">
                        <span class="dt-lbl">ENTRY</span>
                        <span class="dt-val">${entry}</span>
                    </div>
                    <div class="dt-item">
                        <span class="dt-lbl">SL</span>
                        <span class="dt-val c-red">${sl}</span>
                    </div>
                    <div class="dt-item">
                        <span class="dt-lbl">TP1</span>
                        <span class="dt-val">${tp1}</span>
                    </div>
                    <div class="dt-item">
                        <span class="dt-lbl">TP2</span>
                        <span class="dt-val">${tp2}</span>
                    </div>
                    <div class="dt-item">
                        <span class="dt-lbl">TP3</span>
                        <span class="dt-val">${tp3}</span>
                    </div>
                </div>
            </div>
        `;
        container.innerHTML += html;
    });
}

function calculateStats(trades) {
    let totalPoints = 0;
    let wins = 0;
    let losses = 0;
    let active = 0;

    trades.forEach(t => {
        if (t.status === 'ACTIVE' || t.status === 'SETUP') active++;
        else {
            const pts = parseFloat(t.points_gained);
            totalPoints += pts;
            if (pts > 0) wins++;
            else if (pts < 0) losses++;
        }
    });

    const totalClosed = wins + losses;
    const winRate = totalClosed === 0 ? 0 : Math.round((wins / totalClosed) * 100);

    // Update Stats with 2 Decimals
    if(document.getElementById('totalTrades')) document.getElementById('totalTrades').innerText = trades.length;
    if(document.getElementById('winRate')) document.getElementById('winRate').innerText = winRate + "%";
    if(document.getElementById('totalPips')) document.getElementById('totalPips').innerText = totalPoints.toFixed(2);
    if(document.getElementById('activeTrades')) document.getElementById('activeTrades').innerText = active;
    
    // Color the total points
    const pipsEl = document.getElementById('totalPips');
    pipsEl.className = totalPoints >= 0 ? 'stat-val val-green' : 'stat-val c-red';
}

// --- UTILS ---
function toggleSelectionMode() {
    isSelectionMode = !isSelectionMode;
    const checkboxes = document.querySelectorAll('.trade-checkbox');
    const icon = document.getElementById('selectIcon');
    
    checkboxes.forEach(cb => cb.style.display = isSelectionMode ? 'block' : 'none');
    icon.style.color = isSelectionMode ? '#007aff' : '';
    if(!isSelectionMode) checkboxes.forEach(cb => cb.checked = false);
}

function getCheckedIds() {
    return Array.from(document.querySelectorAll('.trade-checkbox:checked')).map(cb => cb.value);
}

async function deleteSelected() {
    if (!isSelectionMode) { toggleSelectionMode(); return; }
    const ids = getCheckedIds();
    if (ids.length === 0) return;
    
    if(!confirm(`Delete ${ids.length} trades?`)) return;

    try {
        const res = await fetch('/api/delete_trades', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trade_ids: ids })
        });
        const result = await res.json();
        if (result.success) toggleSelectionMode();
    } catch (err) { console.error(err); }
}

// Listeners
document.getElementById('filterDate').addEventListener('change', () => applyFilters());
document.getElementById('filterSymbol').addEventListener('keyup', () => applyFilters());
document.getElementById('filterStatus').addEventListener('change', () => applyFilters());
document.getElementById('filterType').addEventListener('change', () => applyFilters());
