// const $ = id => document.getElementById(id);
const $ = (id) => document.getElementById(id);


function parseCurrency(str) {
    if (!str) return 0;
    return Number(str.replace(/[^0-9.-]/g, ""));
}

function formatCurrency(n) {
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

$("mtgAddActualRow").addEventListener("click", () => {
    const tbody = $("mtgActualsBody");
    const tr = document.createElement("tr");

    tr.innerHTML = `
        <td><input type="date" class="mtg-actual-date"></td>
        <td><input type="text" class="mtg-actual-amount" placeholder="$0"></td>
        <td><button class="mtg-remove-row">✕</button></td>
    `;

    tbody.appendChild(tr);

    tr.querySelector(".mtg-remove-row").addEventListener("click", () => {
        tr.remove();
    });
});

function getActualExtraPayments() {
    const rows = [...document.querySelectorAll("#mtgActualsBody tr")];
    const map = {};

    rows.forEach(row => {
        const date = row.querySelector(".mtg-actual-date").value;
        const amt = parseCurrency(row.querySelector(".mtg-actual-amount").value);

        if (date && amt > 0) {
            const monthKey = date.slice(0, 7); // YYYY-MM
            map[monthKey] = (map[monthKey] || 0) + amt;
        }
    });

    return map;
}

function computeMonthlyPayment(principal, annualRate, termYears) {
    const r = annualRate / 12;
    const n = termYears * 12;

    if (r === 0) return principal / n;

    return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}


function buildAmortizationSchedule({
    startDate,
    principal,
    annualRate,
    monthlyPayment,
    extraSchedule = {},
    fixedExtraPerMonth = 0,
    forecastStartDate = null,
    maxMonths = 360 * 2 // safety cap
}) {
    const schedule = [];
    const monthlyRate = annualRate / 12;
    let balance = principal;
    let date = new Date(startDate);

    for (let i = 0; i < maxMonths && balance > 0; i++) {
        const monthKey = date.toISOString().slice(0, 7); // YYYY-MM
        const actualExtra = extraSchedule[monthKey] || 0;


        // Forecast extra (only after forecastStartDate)
        let forecastExtra = 0;
        if (forecastStartDate && dateKey >= forecastStartDate) {
            forecastExtra = fixedExtraPerMonth;
        }

        // Total extra applied this month
        const extra = actualExtra + forecastExtra;


        const interest = balance * monthlyRate;
        let principalPaid = monthlyPayment - interest + extra;

        if (principalPaid > balance) principalPaid = balance;

        balance -= principalPaid;

        schedule.push({
            index: i,
            date: new Date(date),
            balance,
            interest,
            principal: principalPaid - extra,
            extraPrincipal: extra
        });

        date.setMonth(date.getMonth() + 1);
    }

    return schedule;
}

function buildScenarios() {

    const startDate = $("mtgStartDate").value;

    if (!startDate || isNaN(new Date(startDate).getTime())) {
        alert("Please enter a valid start date.");
        return { baseline: [], forecast: [], actual: [] };
    }

    const principal = parseCurrency($("mtgPrincipal").value);
    const annualRate = Number($("mtgRate").value) / 100;
    const termYears = Number($("mtgTermYears").value);

    console.log("DEBUG INPUTS:", {
        principal,
        rawRate: $("mtgRate").value,
        annualRate,
        termYears,
        monthlyPaymentField: $("mtgMonthlyPayment").value
    });

    let monthlyPayment = parseCurrency($("mtgMonthlyPayment").value);
    if (!monthlyPayment) {
        monthlyPayment = computeMonthlyPayment(principal, annualRate, termYears);
        $("mtgMonthlyPayment").value = formatCurrency(monthlyPayment);
    }

    const forecastExtra = parseCurrency($("mtgForecastExtra").value) || 0;
    const forecastStart = $("mtgForecastStart").value;
    const actualExtraMap = getActualExtraPayments();

    const baseline = buildAmortizationSchedule({
        startDate,
        principal,
        annualRate,
        monthlyPayment
    });

    const forecast = buildAmortizationSchedule({
        startDate,
        principal,
        annualRate,
        monthlyPayment,
        fixedExtraPerMonth: forecastExtra,
        forecastStartDate: forecastStart
    });

    const actual = buildAmortizationSchedule({
        startDate,
        principal,
        annualRate,
        monthlyPayment,
        extraSchedule: actualExtraMap
    });

    return { baseline, forecast, actual };
}


function renderSummary({ baseline, forecast, actual }) {
    const payoff = s => s.length ? s[s.length - 1] : null;

    const b = payoff(baseline);
    const f = payoff(forecast);
    const a = payoff(actual);

    if (!b || !f || !a) {
        $("mtgSummary").innerHTML = "<div>Please enter all loan inputs.</div>";
        return;
    }

    const html = `
        <div><strong>No Extra:</strong> payoff ${payoff(baseline).date.toISOString().slice(0, 10)}</div>
        <div><strong>Forecast Extra:</strong> payoff ${payoff(forecast).date.toISOString().slice(0, 10)}</div>
        <div><strong>Actual:</strong> payoff ${payoff(actual).date.toISOString().slice(0, 10)}</div>
    `;

    $("mtgSummary").innerHTML = html;
}

$("mtgRunBtn").addEventListener("click", () => {
    $("mtgLoading").style.display = "inline";

    setTimeout(() => {
        const scenarios = buildScenarios();
        renderSummary(scenarios);
        renderMortgageChart(scenarios);

        console.log("Baseline:", scenarios.baseline);
        console.log("Forecast:", scenarios.forecast);
        console.log("Actual:", scenarios.actual);

        // Show the actual trajectory by default
        const forecastExtra = parseCurrency($("mtgForecastExtra").value) || 0;

        const showSchedule = forecastExtra > 0
            ? scenarios.forecast
            : scenarios.actual;
    

        renderAmortizationTable(showSchedule);




        $("mtgLoading").style.display = "none";
    }, 50);
});

let mortgageChart = null;

function renderMortgageChart({ baseline, forecast, actual }) {
    const ctx = $("mortgageChart").getContext("2d");

    // Destroy old chart if it exists
    if (mortgageChart) mortgageChart.destroy();

    // Convert schedules → Chart.js data points
    const baselineData = baseline.map(p => ({
        x: p.date,
        y: p.balance
    }));

    const forecastData = forecast.map(p => ({
        x: p.date,
        y: p.balance
    }));

    const actualData = actual.map(p => ({
        x: p.date,
        y: p.balance
    }));

    mortgageChart = new Chart(ctx, {
        type: "line",

        data: {
            datasets: [
                {
                    label: "No Extra Principal",
                    data: baselineData,
                    borderColor: "#1f6feb",
                    backgroundColor: "rgba(31, 111, 235, 0.08)",
                    borderWidth: 2,
                    tension: 0.25
                },
                {
                    label: "Consistent Extra Principal",
                    data: forecastData,
                    borderColor: "#1a7f37",
                    backgroundColor: "rgba(26, 127, 55, 0.05)",
                    borderWidth: 2,
                    tension: 0.25
                },
                {
                    label: "Current Trajectory (Actuals)",
                    data: actualData,
                    borderColor: "#b36b00",
                    backgroundColor: "rgba(179, 107, 0, 0.05)",
                    borderDash: [4, 4],
                    borderWidth: 2,
                    tension: 0.25
                }
            ]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,

            scales: {
                x: {
                    type: "time",
                    time: { unit: "month" },
                    title: {
                        display: true,
                        text: "Date"
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: "Remaining Balance ($)"
                    },
                    ticks: {
                        callback: v => formatCurrency(v)
                    }
                }
            },

            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            return `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}`;
                        }
                    }
                },
                legend: {
                    position: "bottom"
                }
            }
        }
    });
}

function renderAmortizationTable(schedule) {
    const body = document.getElementById("mtgAmortBody");
    body.innerHTML = "";

    schedule.forEach(row => {
        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td>${row.date.toLocaleDateString()}</td>
            <td>${(row.interest + row.principal + (row.extraPrincipal || 0)).toFixed(2)}</td>
            <td>${row.interest.toFixed(2)}</td>
            <td>${row.principal.toFixed(2)}</td>
            <td>${(row.extraPrincipal || 0).toFixed(2)}</td>
            <td>${row.balance.toFixed(2)}</td>
        `;

        body.appendChild(tr);
    });
}

