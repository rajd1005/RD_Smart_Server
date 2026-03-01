const API_URL = '/api/trades'; 
let allTrades = []; 
let isSelectionMode = false;
const socket = io(); 
let datePicker;

window.onload = function() {
    initDatePicker();
    fetchTrades();
};

function initDatePicker() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    
    // Initialize Flatpickr in range mode
    datePicker = flatpickr("#filterDateRange", {
        mode: "range",
        dateFormat: "Y-m-d",
        defaultDate: today, // Set today as default
        onChange: function() {
            // Instantly apply filters when user selects a date/range
            applyFilters(); 
        }
    });
}

socket.on('trade_update', () => { fetchTrades(); });

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
    
    // Extract dates from Flatpickr
    let startDate = "";
    let endDate = "";
    if (datePicker && datePicker.selectedDates.length > 0) {
        const formatOpts = { timeZone: 'Asia/Kolkata' };
        startDate = datePicker.selectedDates[0].toLocaleDateString('en-CA', formatOpts);
        // If it's a single date, end date is the same. If range, use the second date.
        endDate = datePicker.selectedDates.length === 2 
            ? datePicker.selectedDates[1].toLocaleDateString('en-CA', formatOpts) 
            : startDate;
    }

    // --- Update Header Text ---
    const dateDisplay = document.getElementById('activeDateDisplay');
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    
    if (!startDate && !endDate) {
        dateDisplay.innerText = "All Time";
    } else if (startDate === endDate) {
        dateDisplay.innerText = (startDate === todayStr) ? "Today" : startDate;
    } else {
        const startText = startDate ? startDate.substring(5) : "Past"; 
        const endText = endDate ? endDate.substring(5) : "Now";
        dateDisplay.innerText = `${startText} to ${endText}`;
    }

    // --- BATCH PROCESSING (Fast Local Filtering) ---
    const filtered = allTrades.reduce((acc, trade) => {
        const tradeDateObj = new Date(trade.created_at);
        const tradeDateStr = tradeDateObj.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        // 1. Fast Date Match Check
        let dateMatch = true;
        if (startDate && endDate) dateMatch = (tradeDateStr >= startDate && tradeDateStr <= endDate);
        else if (startDate) dateMatch = (tradeDateStr >= startDate);
        else if (endDate) dateMatch = (tradeDateStr <= endDate);

        if (!dateMatch) return acc; // Skip instantly if date doesn't match

        // 2. AUTO-CLOSE Old Active Trades
        let displayStatus = trade.status;
        let isVisuallyActive = (trade.status === 'ACTIVE' || trade.status === 'SETUP');
        
        if (isVisuallyActive && tradeDateStr < todayStr) {
            isVisuallyActive = false; 
            const pts = parseFloat(trade.points_gained || 0);
            if (pts > 0) displayStatus = 'PROFIT (CLOSED)';
            else if (pts < 0) displayStatus = 'LOSS (CLOSED)';
            else displayStatus = 'CLOSED (BREAKEVEN)';
        }

        // 3. Apply Dropdown Filters
        const typeMatch = (filterType === 'ALL' || trade.type === filterType);
        const symbolMatch = (filterSymbol === "" || trade.symbol === filterSymbol);
        
        let statusMatch = true;
        if (filterStatus === 'TP') statusMatch = (displayStatus.includes('TP') || displayStatus.includes('PROFIT'));
        else if (filterStatus === 'SL') statusMatch = (displayStatus.includes('SL') || displayStatus.includes('LOSS'));
        else if (filterStatus === 'OPEN') statusMatch = isVisuallyActive;

        if (typeMatch && symbolMatch && statusMatch) {
            acc.push({ ...trade, displayStatus, isVisuallyActive, tradeDateObj });
        }
        
        return acc;
    }, []);

    renderTrades(filtered, preserveIds);
    calculateStats(filtered);
}

// --- 2. BLAZING FAST RENDERING & DATE DISPLAY ---
function renderTrades(trades, preserveIds) {
    const container = document.getElementById('tradeListContainer');
    const noDataMsg = document.getElementById('noData');
    
    if (trades.length === 0) {
        container.innerHTML = '';
        if(noDataMsg) noDataMsg.style.display = 'block';
        return;
    } else {
        if(noDataMsg) noDataMsg.style.display = 'none';
    }

    // Accumulating HTML into a string for a single fast render
    let htmlContent = '';

    trades.forEach((trade) => {
        // NEW: Formatting Date and Time separately
        const dateString = trade.tradeDateObj.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }); 
        const timeString = trade.tradeDateObj.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
        
        const entry = parseFloat(trade.entry_price).toFixed(2);
        const sl = parseFloat(trade.sl_price).toFixed(2);
        const tp1 = parseFloat(trade.tp1_price).toFixed(2);
        const tp2 = parseFloat(trade.tp2_price).toFixed(2);
        const tp3 = parseFloat(trade.tp3_price).toFixed(2);
        const pts = parseFloat(trade.points_gained);
        const displayPts = pts.toFixed(2);

        let profitColor = 'text-muted';
        let statusColor = '#878a8d';
        let statusText = trade.displayStatus.replace(' (Reversal)', '');
        
        // Colors updated to use the new "Visually Active" logic
        if (trade.isVisuallyActive) { statusColor = '#007aff'; }
        else if (statusText.includes('TP') || statusText.includes('PROFIT')) { statusColor = '#00b346'; profitColor = 'c-green'; }
        else if (statusText.includes('SL') || statusText.includes('LOSS')) { statusColor = '#ff3b30'; profitColor = 'c-red'; }
        else if (pts > 0) { profitColor = 'c-green'; }
        else if (pts < 0) { profitColor = 'c-red'; }

        const badgeClass = trade.type === 'BUY' ? 'bg-buy' : 'bg-sell';
        const isChecked = preserveIds.includes(trade.trade_id) ? 'checked' : '';
        const checkDisplay = isSelectionMode ? 'block' : 'none';

        htmlContent += `
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
                    <span class="tc-time">${dateString} • ${timeString}</span>
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
    });
    
    // Inject the final HTML instantly
    container.innerHTML = htmlContent;
}

// --- 3. ACCURATE STATS BASED ON AUTO-CLOSED TRADES ---
function calculateStats(trades) {
    let totalPoints = 0; let wins = 0; let losses = 0; let active = 0;
    trades.forEach(t => {
        if (t.isVisuallyActive) {
            active++;
        } else {
            // Calculates points for past active trades that are now closed
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

// Keep the others:
document.getElementById('filterSymbol').addEventListener('change', () => applyFilters());
document.getElementById('filterStatus').addEventListener('change', () => applyFilters());
document.getElementById('filterType').addEventListener('change', () => applyFilters());
