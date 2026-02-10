const API_URL = '/api/trades'; 
let allTrades = []; 

window.onload = function() {
    setTodayDate();
    fetchTrades();
};

// --- FIX 1: Set Date Input to IST (YYYY-MM-DD) ---
function setTodayDate() {
    // 'en-CA' locale formats date as YYYY-MM-DD automatically
    const istDate = new Date().toLocaleDateString('en-CA', { 
        timeZone: 'Asia/Kolkata' 
    });
    document.getElementById('filterDate').value = istDate;
}

async function fetchTrades() {
    try {
        const response = await fetch(API_URL);
        allTrades = await response.json();
        applyFilters(); 
    } catch (error) {
        console.error("Error fetching trades:", error);
    }
}

// --- FIX 2: Filter Logic using IST Dates ---
function applyFilters() {
    const filterSymbol = document.getElementById('filterSymbol').value.toUpperCase();
    const filterStatus = document.getElementById('filterStatus').value;
    const filterDateInput = document.getElementById('filterDate').value; 

    const filtered = allTrades.filter(trade => {
        // Convert the database time (UTC/ISO) to IST Date String (YYYY-MM-DD)
        const tradeDateObj = new Date(trade.created_at);
        const tradeDateStr = tradeDateObj.toLocaleDateString('en-CA', { 
            timeZone: 'Asia/Kolkata' 
        });

        const matchesDate = (filterDateInput === "") || (tradeDateStr === filterDateInput);
        const matchesSymbol = trade.symbol.includes(filterSymbol);
        const matchesStatus = filterStatus === 'ALL' || 
                              (filterStatus === 'TP' && trade.status.includes('TP')) ||
                              (filterStatus === 'SL' && trade.status.includes('SL')) ||
                              (filterStatus === 'OPEN' && trade.status === 'ACTIVE');

        return matchesDate && matchesSymbol && matchesStatus;
    });

    renderTable(filtered);
    calculateStats(filtered);
}

function renderTable(trades) {
    const tbody = document.getElementById('tradeTableBody');
    const noDataMsg = document.getElementById('noDataMessage');
    
    tbody.innerHTML = '';
    
    if (trades.length === 0) {
        if(noDataMsg) noDataMsg.style.display = 'block';
        return;
    } else {
        if(noDataMsg) noDataMsg.style.display = 'none';
    }

    trades.forEach((trade, index) => {
        const dateObj = new Date(trade.created_at);
        
        // --- FIX 3: Display Time in IST ---
        const timeString = dateObj.toLocaleTimeString('en-US', { 
            timeZone: 'Asia/Kolkata',
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: true 
        });

        let statusClass = 'text-secondary';
        if (trade.status === 'ACTIVE') statusClass = 'status-active';
        if (trade.status.includes('TP')) statusClass = 'status-tp';
        if (trade.status.includes('SL')) statusClass = 'status-sl';

        let pts = parseFloat(trade.points_gained);
        let ptsColor = pts > 0 ? 'text-success' : (pts < 0 ? 'text-danger' : 'text-muted');
        
        let displayPts = Math.abs(pts) < 10 && Math.abs(pts) > 0 ? pts.toFixed(5) : pts.toFixed(2);

        const row = `
            <tr>
                <td>${timeString}</td>
                <td><b>${trade.symbol}</b></td>
                <td><span class="badge ${trade.type === 'BUY' ? 'badge-buy' : 'badge-sell'}">${trade.type}</span></td>
                <td class="${statusClass}">${trade.status}</td>
                <td>${parseFloat(trade.entry_price).toFixed(5)}</td>
                <td>${parseFloat(trade.sl_price).toFixed(5)}</td>
                <td>${parseFloat(trade.tp1_price).toFixed(5)}</td>
                <td>${parseFloat(trade.tp2_price).toFixed(5)}</td>
                <td>${parseFloat(trade.tp3_price).toFixed(5)}</td>
                <td class="fw-bold ${ptsColor}" style="font-size:1.1rem">${displayPts}</td>
            </tr>
        `;
        tbody.innerHTML += row;
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

    if(document.getElementById('totalTrades')) document.getElementById('totalTrades').innerText = trades.length;
    if(document.getElementById('winRate')) document.getElementById('winRate').innerText = winRate + "%";
    
    let displayTotal = Math.abs(totalPoints) < 10 && Math.abs(totalPoints) > 0 ? totalPoints.toFixed(5) : totalPoints.toFixed(2);
    if(document.getElementById('totalPips')) document.getElementById('totalPips').innerText = displayTotal;
    
    if(document.getElementById('activeTrades')) document.getElementById('activeTrades').innerText = active;
}

// Event Listeners
document.getElementById('filterDate').addEventListener('change', applyFilters);
document.getElementById('filterSymbol').addEventListener('keyup', applyFilters);
document.getElementById('filterStatus').addEventListener('change', applyFilters);
