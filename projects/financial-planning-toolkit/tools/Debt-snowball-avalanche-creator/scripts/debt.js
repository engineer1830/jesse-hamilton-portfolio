// ===============================
// Debt Snowball / Avalanche Tool
// ===============================

// ---------- STATE ----------
let debts = [];

// DOM references
const debtRows = document.querySelector("#debt-rows");
const addDebtBtn = document.querySelector("#add-debt-btn");
const runBtn = document.querySelector("#run-simulation-btn");
const errorMessage = document.querySelector("#debt-error-message");

// Results DOM
const resultsSection = document.querySelector("#debt-results");
const resultsMethod = document.querySelector("#results-method");
const resultsMonths = document.querySelector("#results-months");
const resultsInterest = document.querySelector("#results-interest");
const resultsPayoffDate = document.querySelector("#results-payoff-date");
const resultsPayoffOrder = document.querySelector("#results-payoff-order");
const scheduleRows = document.querySelector("#schedule-rows");

// Chart
let debtChart = null;



// ===============================
// 0. PAYMENT CALCULATION (NEW)
// ===============================

function computeMonthlyPayment(principal, annualRate, termMonths) {
    const r = annualRate / 12;
    if (termMonths === null || termMonths <= 0) return 0;
    if (r === 0) return principal / termMonths;
    return (r * principal) / (1 - Math.pow(1 + r, -termMonths));
}



// ===============================
// 1. ADD / REMOVE DEBT ROWS
// ===============================

function addDebtRow() {
    const id = crypto.randomUUID();

    const row = document.createElement("tr");
    row.dataset.id = id;

    row.innerHTML = `
    <td><input type="text" class="debt-name" placeholder="Debt name"></td>
    <td><input type="number" class="debt-balance" min="0" step="0.01"></td>
    <td><input type="number" class="debt-rate" min="0" step="0.01"></td>
    <td><input type="number" class="debt-term" min="0" step="1" placeholder="—"></td>
    <td><input type="number" class="debt-min" min="0" step="1"></td>
    <td>
      <button class="remove-debt-btn">✕</button>
    </td>
  `;

    debtRows.appendChild(row);

    row.querySelector(".remove-debt-btn").addEventListener("click", () => {
        row.remove();
    });
}

addDebtBtn.addEventListener("click", addDebtRow);



// ===============================
// 2. READ INPUTS INTO STATE
// ===============================

function readDebts() {
    const rows = [...document.querySelectorAll("#debt-rows tr")];

    const parsed = rows.map(row => {
        const principal = Number(row.querySelector(".debt-balance").value);
        const rate = Number(row.querySelector(".debt-rate").value) / 100;
        const term = Number(row.querySelector(".debt-term").value) || null;
        let minPayment = Number(row.querySelector(".debt-min").value);

        // Auto-calc minimum payment if term is provided and minPayment is blank
        if ((!minPayment || minPayment === 0) && term) {
            minPayment = computeMonthlyPayment(principal, rate, term);
        }

        return {
            id: row.dataset.id,
            name: row.querySelector(".debt-name").value.trim() || "Debt",
            principal,
            interestRate: rate,
            termMonths: term,
            minPayment
        };
    });

    return parsed.filter(d => d.principal > 0);
}



// ===============================
// 3. SORTING (Snowball / Avalanche)
// ===============================

function sortDebts(debts, method) {
    if (method === "snowball") {
        return debts.sort((a, b) => a.principal - b.principal);
    }
    if (method === "avalanche") {
        return debts.sort((a, b) => b.interestRate - a.interestRate);
    }
    return debts;
}



// ===============================
// 4. SIMULATION ENGINE
// ===============================

function simulateDebtPayoff(debts, monthlyBudget, method) {
    const schedule = [];
    const sorted = sortDebts([...debts], method);

    let month = 1;
    let totalInterest = 0;

    while (sorted.some(d => d.principal > 0)) {
        let remaining = monthlyBudget;

        // 1. Minimum payments
        sorted.forEach(d => {
            if (d.principal <= 0) return;

            const payment = Math.min(d.minPayment, d.principal);
            d.principal -= payment;
            remaining -= payment;
        });

        // 2. Extra payment to target debt
        const target = sorted.find(d => d.principal > 0);
        if (target && remaining > 0) {
            const extra = Math.min(remaining, target.principal);
            target.principal -= extra;
            remaining -= extra;
        }

        // 3. Interest accrual
        sorted.forEach(d => {
            if (d.principal <= 0) return;
            const interest = d.principal * (d.interestRate / 12);
            d.principal += interest;
            totalInterest += interest;
        });

        // 4. Record month
        const totalBalance = sorted.reduce((sum, d) => sum + Math.max(d.principal, 0), 0);

        schedule.push({
            month,
            totalBalance,
            debts: sorted.map(d => ({
                name: d.name,
                balance: d.principal
            }))
        });

        month++;
    }

    return {
        schedule,
        totalMonths: schedule.length,
        totalInterest
    };
}



// ===============================
// 5. RENDER RESULTS
// ===============================

function renderResults(method, simulation) {
    const { schedule, totalMonths, totalInterest } = simulation;

    resultsMethod.textContent = method;
    resultsMonths.textContent = totalMonths;
    resultsInterest.textContent = `$${totalInterest.toFixed(2)}`;

    // Payoff date
    const payoffDate = new Date();
    payoffDate.setMonth(payoffDate.getMonth() + totalMonths);
    resultsPayoffDate.textContent = payoffDate.toLocaleDateString();

    // Payoff order
    resultsPayoffOrder.innerHTML = "";
    const payoffOrder = [...schedule[0].debts]
        .sort((a, b) => a.balance - b.balance)
        .map(d => d.name);

    payoffOrder.forEach(name => {
        const li = document.createElement("li");
        li.textContent = name;
        resultsPayoffOrder.appendChild(li);
    });

    // Schedule table
    scheduleRows.innerHTML = "";
    schedule.forEach(row => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td>${row.month}</td>
      <td>$${row.totalBalance.toFixed(2)}</td>
      <td><button class="btn ghost-btn" data-month="${row.month}">Details</button></td>
    `;
        scheduleRows.appendChild(tr);
    });

    // Chart
    renderChart(schedule);

    resultsSection.style.display = "block";
}

function renderComparison(snowball, avalanche) {
    // Snowball
    document.querySelector("#snowball-months").textContent = snowball.totalMonths;
    document.querySelector("#snowball-interest").textContent = `$${snowball.totalInterest.toFixed(2)}`;

    const snowballDate = new Date();
    snowballDate.setMonth(snowballDate.getMonth() + snowball.totalMonths);
    document.querySelector("#snowball-date").textContent = snowballDate.toLocaleDateString();

    const snowballOrder = [...snowball.schedule[0].debts]
        .sort((a, b) => a.balance - b.balance)
        .map(d => d.name);

    const snowballList = document.querySelector("#snowball-order");
    snowballList.innerHTML = "";
    snowballOrder.forEach(name => {
        const li = document.createElement("li");
        li.textContent = name;
        snowballList.appendChild(li);
    });

    // Avalanche
    document.querySelector("#avalanche-months").textContent = avalanche.totalMonths;
    document.querySelector("#avalanche-interest").textContent = `$${avalanche.totalInterest.toFixed(2)}`;

    const avalancheDate = new Date();
    avalancheDate.setMonth(avalancheDate.getMonth() + avalanche.totalMonths);
    document.querySelector("#avalanche-date").textContent = avalancheDate.toLocaleDateString();

    const avalancheOrder = [...avalanche.schedule[0].debts]
        .sort((a, b) => a.balance - b.balance)
        .map(d => d.name);

    const avalancheList = document.querySelector("#avalanche-order");
    avalancheList.innerHTML = "";
    avalancheOrder.forEach(name => {
        const li = document.createElement("li");
        li.textContent = name;
        avalancheList.appendChild(li);
    });

    // Summary
    const summary = document.querySelector("#comparison-summary-text");

    const monthDiff = snowball.totalMonths - avalanche.totalMonths;
    const interestDiff = snowball.totalInterest - avalanche.totalInterest;

    let text = "";

    if (monthDiff > 0) {
        text += `Avalanche pays off ${monthDiff} months faster. `;
    } else if (monthDiff < 0) {
        text += `Snowball pays off ${Math.abs(monthDiff)} months faster. `;
    }

    if (interestDiff > 0) {
        text += `Avalanche saves $${interestDiff.toFixed(2)} in interest.`;
    } else if (interestDiff < 0) {
        text += `Snowball saves $${Math.abs(interestDiff).toFixed(2)} in interest.`;
    }

    summary.textContent = text || "Both methods produce identical results.";
}
  



// ===============================
// 6. CHART RENDERING
// ===============================

function renderChart(schedule) {
    const ctx = document.querySelector("#debt-balance-chart");

    const labels = schedule.map(s => s.month);
    const data = schedule.map(s => s.totalBalance);

    if (debtChart) debtChart.destroy();

    debtChart = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Total Debt Balance",
                    data,
                    borderColor: "#0077cc",
                    backgroundColor: "rgba(0, 119, 204, 0.15)",
                    tension: 0.2,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: false
                }
            }
        }
    });
}



// ===============================
// 7. RUN SIMULATION
// ===============================

runBtn.addEventListener("click", () => {
    errorMessage.textContent = "";

    const monthlyBudget = Number(document.querySelector("#monthly-budget").value);
    const method = document.querySelector("input[name='payoffMethod']:checked").value;

    debts = readDebts();

    if (debts.length === 0) {
        errorMessage.textContent = "Please enter at least one debt.";
        return;
    }

    if (monthlyBudget <= 0) {
        errorMessage.textContent = "Monthly budget must be greater than zero.";
        return;
    }

    // Run both simulations
    // const snowball = simulateDebtPayoff(debts, monthlyBudget, "snowball");
    // const avalanche = simulateDebtPayoff(debts, monthlyBudget, "avalanche");

    const snowball = simulateDebtPayoff(structuredClone(debts), monthlyBudget, "snowball");
    const avalanche = simulateDebtPayoff(structuredClone(debts), monthlyBudget, "avalanche");


    // Render the selected method in the main summary
    const selected = method === "snowball" ? snowball : avalanche;
    renderResults(method, selected);

    // Render the side-by-side comparison
    renderComparison(snowball, avalanche);
});
  

