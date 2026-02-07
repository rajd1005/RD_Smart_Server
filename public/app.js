const API_URL = window.location.origin + '/api/trades';

async function fetchTrades() {
    try {
        const response = await fetch(API_URL);
        const trades = await response.json();
        
        // Filter Data locally before rendering
        const filterSymbol = document.getElementById('filterSymbol').value.toUpperCase();
        const filterStatus = document.getElementById('filterStatus').value;

        const filteredTrades = trades.filter(trade => {
            const matchesSymbol = trade.symbol.includes(filterSymbol);
            const matchesStatus = filterStatus === 'ALL' || 
                                  (filterStatus === 'TP' && trade.status.includes('TP')) ||
                                  (filterStatus === 'SL' && trade.status.includes('SL')) ||
                                  (filterStatus === 'OPEN' && trade.status === 'OPEN');
            return matchesSymbol && matchesStatus;
        });

        renderTable(filteredTrades);
        calculateStats(filteredTrades);

    } catch (error) {
        console.error("Error fetching trades:", error);
    }
}

function renderTable(trades) {
    const tbody = document.getElementById('tradeTableBody');
    tbody.innerHTML = '';

    trades.forEach((trade, index) => {
        const date = new Date(trade.created_at).toLocaleString();
        
        let statusClass = 'text-secondary';
        if (trade.status === 'OPEN') statusClass = 'status-open';
        if (trade.status.includes('TP')) statusClass = 'status-tp';
        if (trade.status.includes('SL')) statusClass = 'status-sl';

        const row = `
            <tr>
                <td>${index + 1}</td>
                <td>${date}</td>
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

// Initial Load
fetchTrades();

// Event Listeners for Filters
document.getElementById('filterSymbol').addEventListener('keyup', fetchTrades);
document.getElementById('filterStatus').addEventListener('change', fetchTrades);
