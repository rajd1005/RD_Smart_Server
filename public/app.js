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
        
        populateSymbolFilter(allTrades);
        applyFilters(checkedIds); 
    } catch (error) { console.error(error); }
}

function populateSymbolFilter(trades) {
    const symbolSelect = document.getElementById('filterSymbol');
    const currentVal = symbolSelect.value;
    const uniqueSymbols = [...new Set(trades.map(t => t.symbol))].sort();
    
    symbolSelect.innerHTML = '<option value="">All Symbols</option>';
    uniqueSymbols.forEach(sym => {
        const option = document.createElement('option');
        option.value = sym;
        option.text = sym;
        symbolSelect.appendChild(option);
    });
    if(uniqueSymbols.includes(currentVal)) symbolSelect.value = currentVal;
}

function applyFilters(preserveIds = []) {
    const filterSymbol = document.getElementById('filterSymbol').value;
    const filterStatus = document.getElementById('filterStatus').value;
    const filterType = document.getElementById('filterType').value;
    const filterDateInput = document.getElementById('filterDate').value; 

    const filtered = allTrades.filter(trade => {
        const tradeDateObj = new Date(trade.created_at);
        const tradeDateStr = tradeDateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        return ((filterDateInput === "") || (tradeDateStr === filterDateInput)) &&
               (filterSymbol === "" || trade.symbol === filterSymbol) &&
               (filterType === 'ALL' || trade.type === filterType) &&
               (filterStatus === 'ALL' || 
               (filterStatus === 'TP' && trade.status.includes('TP')) ||
               (filterStatus === 'SL' && trade.status.includes('SL')) ||
               (filterStatus === 'OPEN' && trade.status === 'ACTIVE'));
    });

    renderTrades(filtered, preserveIds);
    calculateStats(filtered);
}

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
        const timeString = dateObj.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
        
        const entry = parseFloat(trade.entry_price).toFixed(2);
        const sl = parseFloat(trade.sl_price).toFixed(2);
        const tp1 = parseFloat(trade.tp1_price).toFixed(2);
        const tp2 = parseFloat(trade.tp2_price).toFixed(2);
        const tp3 = parseFloat(trade.tp3_price).toFixed(2);
        const pts = parseFloat(trade.points_gained);
        const displayPts = pts.toFixed(2);

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
                    <div class="dt-item"><span class="dt-lbl">ENTRY</span><span class="dt-val">${entry}</span></div>
                    <div class="dt-item"><span class="dt-lbl">SL</span><span class="dt-val c-red">${sl}</span></div>
                    <div class="dt-item"><span class="dt-lbl">TP1</span><span class="dt-val">${tp1}</span></div>
                    <div class="dt-item"><span class="dt-lbl">TP2</span><span class="dt-val">${tp2}</span></div>
                    <div class="dt-item"><span class="dt-lbl">TP3</span><span class="dt-val">${tp3}</span></div>
                </div>
            </div>`;
        container.innerHTML += html;
    });
}

function calculateStats(trades) {
    let totalPoints = 0; let wins = 0; let losses = 0; let active = 0;
    trades.forEach(t => {
        if (t.status === 'ACTIVE' || t.status === 'SETUP') active++;
        else {
            const pts = parseFloat(t.points_gained);
            totalPoints += pts;
            if (pts > 0) wins++; else if (pts < 0) losses++;
        }
    });
    const totalClosed = wins + losses;
    const winRate = totalClosed === 0 ? 0 : Math.round((wins / totalClosed) * 100);

    if(document.getElementById('totalTrades')) document.getElementById('totalTrades').innerText = trades.length;
    if(document.getElementById('winRate')) document.getElementById('winRate').innerText = winRate + "%";
    
    const pipsEl = document.getElementById('totalPips');
    pipsEl.innerText = totalPoints.toFixed(2);
    pipsEl.className = totalPoints >= 0 ? 'stat-val val-green' : 'stat-val val-red';
    
    if(document.getElementById('activeTrades')) document.getElementById('activeTrades').innerText = active;
}

// --- NEW: TOGGLE MODES ---
function toggleSelectionMode() {
    isSelectionMode = !isSelectionMode;
    const checkboxes = document.querySelectorAll('.trade-checkbox');
    const navDefault = document.getElementById('navDefault');
    const navSelection = document.getElementById('navSelection');

    // Toggle Nav Bars
    if(isSelectionMode) {
        navDefault.style.display = 'none';
        navSelection.style.display = 'flex';
    } else {
        navDefault.style.display = 'flex';
        navSelection.style.display = 'none';
        // Uncheck all if cancelled
        checkboxes.forEach(cb => cb.checked = false);
    }

    // Toggle Checkboxes Visibility
    checkboxes.forEach(cb => cb.style.display = isSelectionMode ? 'block' : 'none');
}

// --- NEW: SELECT ALL FUNCTION ---
function selectAllTrades() {
    const checkboxes = document.querySelectorAll('.trade-checkbox');
    // Check if ALL are currently checked
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    
    // Toggle state: If all checked -> Uncheck all. Otherwise -> Check all.
    checkboxes.forEach(cb => cb.checked = !allChecked);
}

function getCheckedIds() { return Array.from(document.querySelectorAll('.trade-checkbox:checked')).map(cb => cb.value); }

async function deleteSelected() {
    if (!isSelectionMode) { toggleSelectionMode(); return; }
    const ids = getCheckedIds();
    if (ids.length === 0) return;
    
    const password = prompt("🔒 Enter Admin Password to delete:");
    if (!password) return; 

    try {
        const res = await fetch('/api/delete_trades', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trade_ids: ids, password: password }) 
        });
        const result = await res.json();
        
        if (result.success) {
            toggleSelectionMode(); // Exit mode
            alert("✅ Deleted Successfully");
            // No need to fetch, socket will trigger update
        } else {
            alert(result.msg || "❌ Error Deleting");
        }
    } catch (err) { console.error(err); }
}

document.getElementById('filterDate').addEventListener('change', () => applyFilters());
document.getElementById('filterSymbol').addEventListener('change', () => applyFilters());
document.getElementById('filterStatus').addEventListener('change', () => applyFilters());
document.getElementById('filterType').addEventListener('change', () => applyFilters());
