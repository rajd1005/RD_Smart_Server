const API_URL = '/api/trades'; // Relative path works automatically
let allTrades = []; // Store data locally to avoid re-fetching on every filter change

// --- 1. INITIALIZATION ---
window.onload = function() {
    // Set Date Picker to Today (IST)
    setTodayDate();
    fetchTrades();
};

function setTodayDate() {
    const today = new Date();
    // Adjust to India Time for the default value
    const offset = 5.5 * 60 * 60 * 1000; 
    const indiaTime = new Date(today.getTime() + offset); 
    const dateStr = indiaTime.toISOString().split('T')[0];
    document.getElementById('filterDate').value = dateStr;
}

// --- 2. FETCH DATA ---
async function fetchTrades() {
    try {
        const response = await fetch(API_URL);
        allTrades = await response.json();
        applyFilters(); // Apply filters immediately after fetching
    } catch (error) {
        console.error("Error fetching trades:", error);
    }
}

function refreshData() {
    fetchTrades();
}

// --- 3. FILTER LOGIC ---
function applyFilters() {
    const filterSymbol = document.getElementById('filterSymbol').value.toUpperCase();
    const filterStatus = document.getElementById('filterStatus').value;
    const filterDateInput = document.getElementById('filterDate').value; // YYYY-MM-DD

    const filtered = allTrades.filter(trade => {
        // Parse Trade Date (Stored as "2/7/2026, 5:30:00 PM" string)
        const tradeDateObj = new Date(trade.created_at);
        const tradeDateStr = tradeDateObj.toISOString().split('T')[0];

        // 1. Check Date
        const matchesDate = (filterDateInput === "") || (tradeDateStr === filterDateInput);
        
        // 2. Check Symbol
        const matchesSymbol = trade.symbol.includes(filterSymbol);
        
        // 3. Check Status
        const matchesStatus = filterStatus === 'ALL' || 
                              (filterStatus === 'TP' && trade.status.includes('TP')) ||
                              (filterStatus === 'SL' && trade.status.includes('SL')) ||
                              (filterStatus === 'OPEN' && trade.status === 'OPEN');

        return matchesDate && matchesSymbol && matchesStatus;
    });

    renderTable(filtered);
    calculateStats(filtered);
}

// --- 4. RENDER TABLE ---
function renderTable(trades) {
    const tbody = document.getElementById('tradeTableBody');
    const noDataMsg = document.getElementById('noDataMessage');
    
    tbody.innerHTML = '';
    
    if (trades.length === 0) {
        noDataMsg.style.display = 'block';
        return;
    } else {
        noDataMsg.style.display = 'none';
    }

    trades.forEach((trade, index) => {
        // Format Time nicely
        const dateObj = new Date(trade.created_at);
        const timeString = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

        let statusClass = 'text-secondary';
        if (trade.status === 'OPEN') statusClass = 'status-open';
        if (trade.status.includes('TP')) statusClass = 'status-tp';
        if (trade.status.includes('SL')) statusClass = 'status-sl';

        const row = `
            <tr>
                <td>${index + 1}</td>
                <td>${timeString}</td>
                <td><b>${trade.symbol}</b></td>
                <td><span class="badge ${trade.type === 'BUY' ? 'bg-primary' : 'bg-danger'}">${trade.type}</span></td>
                <td>${trade.entry_price}</td>
                <td class="${statusClass}">${trade.status}</td>
                <td style="font-weight:bold; color: ${trade.pips_gained >= 0 ? 'green' : 'red'}">
                    ${parseFloat(trade.pips_gained).toFixed(1)}
                </span></td>
            </tr>
        `;
        tbody.innerHTML += row;
    });
}

function calculateStats(trades) {
    let totalPips = 0;
    let wins = 0;
    let losses = 0;
    let active = 0;

    trades.forEach(t => {
        if (t.status === 'OPEN') active++;
        else {
            const pips = parseFloat(t.pips_gained);
            totalPips += pips;
            if (pips > 0) wins++;
            else losses++;
        }
    });

    const totalClosed = wins + losses;
    const winRate = totalClosed === 0 ? 0 : Math.round((wins / totalClosed) * 100);

    document.getElementById('totalTrades').innerText = trades.length;
    document.getElementById('winRate').innerText = winRate + "%";
    document.getElementById('totalPips').innerText = totalPips.toFixed(1);
    document.getElementById('activeTrades').innerText = active;
}

function resetFilters() {
    setTodayDate();
    document.getElementById('filterSymbol').value = "";
    document.getElementById('filterStatus').value = "ALL";
    applyFilters();
}

// Event Listeners
document.getElementById('filterDate').addEventListener('change', applyFilters);
document.getElementById('filterSymbol').addEventListener('keyup', applyFilters);
document.getElementById('filterStatus').addEventListener('change', applyFilters);
