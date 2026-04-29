/* ---------------------------------------------------
   FORMAT HELPER
--------------------------------------------------- */

function formatCurrencyInput(input) {
    // Remove everything except digits
    let raw = input.value.replace(/[^\d]/g, "");

    // Prevent leading zeros from causing weird formatting
    if (raw === "") {
        input.value = "";
        input.dataset.raw = "0";
        return;
    }

    // Convert to number
    const num = parseInt(raw, 10);

    // Store raw value for your engine
    input.dataset.raw = num;

    // Format with commas and $
    input.value = "$" + num.toLocaleString();
}

const currencyInputs = [
    "currentRoth",
    "currentTrad",
    "contribution",
    "ssAnnual",
    "spendingNeed"
];

currencyInputs.forEach(id => {
    const el = document.getElementById(id);

    // Format on load
    formatCurrencyInput(el);

    // Format as user types
    el.addEventListener("input", () => formatCurrencyInput(el));

    // Optional: remove $ and commas when focusing
    el.addEventListener("focus", () => {
        el.value = el.dataset.raw || "";
    });

    // Reformat on blur
    el.addEventListener("blur", () => formatCurrencyInput(el));
});

function enforceAgeLimits() {
    const currentAge = parseInt($("currentAge").value) || 0;

    const retirementAgeEl = $("retirementAge");
    const workStopAgeEl = $("workStopAge");

    // Retirement age cannot be < current age
    if (retirementAgeEl && parseInt(retirementAgeEl.value) < currentAge) {
        retirementAgeEl.value = currentAge;
    }

    // Work stop age cannot be < current age
    if (workStopAgeEl && parseInt(workStopAgeEl.value) < currentAge) {
        workStopAgeEl.value = currentAge;
    }
}


/* ---------------------------------------------------
   COMPARISON SCENARIOS
--------------------------------------------------- */

// Stores up to 3 scenario results from the FULL engine
let scenarioRuns = [null, null, null];
let scenarioLabels = [null, null, null];


// updated buildScenarioSnapshot troubleshooting stressage

function buildScenarioSnapshot(data, insights) {
    return {
        // Identity
        label: `Claim at ${data.taxContext?.claimAge}, retire at ${data.taxContext?.retirementAge}`,

        // User inputs
        currentAge: data.taxContext?.currentAge ?? null,
        retirementAge: data.taxContext?.retirementAge ?? null,
        claimAge: data.taxContext?.claimAge ?? null,
        currentRoth: data.currentRoth ?? 0,
        currentTrad: data.currentTrad ?? 0,
        contribution: data.contribution ?? null,
        ssAtClaimAge: data.retirementTaxDetails?.ssAtClaimAge ?? 0,
        spendingNeedAtRetirement: insights.spendingNeedAtRetirement ?? 0,

        // Engine outputs (keep portfolio depletion from insights, which already
        // reads from withdrawalReport / result.depletionAge)
        portfolioDepletionAge: insights.portfolioDepletionAge,

        // 🔁 STRESS AGE: use deterministic engine, same as renderSummary
        stressAge: Math.min(
            data.withdrawalReport?.tradDepletionAge ?? Infinity,
            data.withdrawalReport?.rothDepletionAge ?? Infinity
        ),

        rothAtRetirement: insights.rothAtRetirement,
        tradAtRetirement: insights.tradAtRetirement,
        requiredWithdrawalRate: insights.requiredWithdrawalRate,
        spendingGap: insights.spendingGap,
        retirementReadiness: insights.retirementReadiness,
        bufferScore: insights.bufferScore,
        zone: insights.zone,

        // Early‑retirement pressure metrics
        yearsWithoutSS: insights.yearsWithoutSS,
        earlyRetirementBurden: insights.earlyRetirementBurden
    };
}


function saveScenarioRun(snapshot) {
    for (let i = 0; i < 3; i++) {
        if (!scenarioRuns[i]) {
            scenarioRuns[i] = snapshot;
            scenarioLabels[i] = snapshot.label;
            console.log(`Saved scenario in slot ${i + 1}`, snapshot);
            return;
        }
    }
    alert("All 3 scenario slots are full. Clear them before saving new runs.");
}

function clearScenarios() {
    scenarioRuns = [null, null, null];
    scenarioLabels = [null, null, null];

    const container = document.getElementById("comparison-section");
    if (container) container.innerHTML = "";

    console.log("Scenario comparison data cleared.");
}

function compareScenarios() {
    const runs = scenarioRuns.filter(r => r !== null);

    if (runs.length < 2) {
        alert("Run at least two scenarios before comparing.");
        return;
    }

    renderScenarioComparison(runs);
}

document.getElementById("compare-scenarios-btn")
    .addEventListener("click", compareScenarios);

document.getElementById("clear-scenarios-btn")
    .addEventListener("click", clearScenarios);


/* ---------------------------------------------------
   CHART SHADING SET UP
--------------------------------------------------- */

const phaseShadingPlugin = {
    id: "phaseShading",
    beforeDraw(chart, args, options) {
        const {
            ctx,
            chartArea: { left, right, top, bottom },
            scales: { x }
        } = chart;

        const phases = options.phases || [];
        ctx.save();

        phases.forEach(phase => {
            const xStart = x.getPixelForValue(phase.startAge);
            const xEnd = x.getPixelForValue(phase.endAge);

            ctx.fillStyle = phase.color;
            ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
        });

        ctx.restore();
    }
};

function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return "$0.00";
    return Number(value).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return "0.0%";
    return (value * 100).toFixed(1) + "%";
}

function limitToLastNYears(prices, years = 10) {
    if (!prices || prices.length === 0) return prices;

    const lastDate = new Date(prices[prices.length - 1].date);
    const cutoff = new Date(lastDate);
    cutoff.setFullYear(cutoff.getFullYear() - years);

    return prices.filter(p => {
        const d = new Date(p.date);
        return d >= cutoff && p.close > 0;
    });
}

function getBufferClass(score) {
    if (score >= 80) return "buffer-strong";      // deep green
    if (score >= 60) return "buffer-supported";   // advisor blue
    if (score >= 40) return "buffer-warning";     // amber
    return "buffer-danger";                       // red
}


import { Finance } from "../../../scripts/engine.js";
import { getHistoricalPrices, getMultipleTickers } from "../../../scripts/data.js";
import { calculateCAGR } from "../../../scripts/transforms.js";
import { estimateRetirementTaxRate } from "./retirement.js";

// Simple IRS Uniform Lifetime Table approximation
function getRmdDivisor(age) {
    if (age < 73) return Infinity; // no RMD yet
    if (age === 73) return 26.5;
    if (age === 74) return 25.5;
    if (age === 75) return 24.6;
    if (age === 76) return 23.7;
    if (age === 77) return 22.9;
    if (age === 78) return 22.0;
    if (age === 79) return 21.1;
    if (age === 80) return 20.2;
    if (age === 81) return 19.4;
    if (age === 82) return 18.5;
    if (age === 83) return 17.7;
    if (age === 84) return 16.8;
    if (age === 85) return 16.0;
    // beyond: just keep decreasing slowly
    return 16 - (age - 85) * 0.7;
}

function computeTaxableSS(ssAnnual, filingStatus) {
    // IRS simplified provisional income thresholds
    const base = filingStatus === "married" ? 32000 : 25000;
    const max = filingStatus === "married" ? 44000 : 34000;

    // For now, provisional income = SS only (you can expand later)
    const provisional = ssAnnual;

    if (provisional <= base) return 0;
    if (provisional <= max) return 0.5 * (provisional - base);

    return 0.85 * (provisional - max) + 0.5 * (max - base);
}

// -------------------------------------------------------
// TAX BRACKETS & IRMAA THRESHOLDS (HELPERS)
// -------------------------------------------------------

function getBracketThresholds({ filingStatus }) {
    // 2024 simplified brackets (good enough for modeling)
    if (filingStatus === "single") {
        return {
            stdDeduction: 14600,
            brackets: [
                { rate: 0.10, top: 11600 },
                { rate: 0.12, top: 47150 },
                { rate: 0.22, top: 100525 },
                { rate: 0.24, top: 191950 }
            ]
        };
    }

    // Married Filing Jointly
    return {
        stdDeduction: 29200,
        brackets: [
            { rate: 0.10, top: 23200 },
            { rate: 0.12, top: 94300 },
            { rate: 0.22, top: 201050 },
            { rate: 0.24, top: 383900 }
        ]
    };
}

function getIrmaaThresholds({ filingStatus }) {
    // MAGI thresholds (simplified)
    if (filingStatus === "single") {
        return [103000, 129000, 161000, 193000, 500000];
    }

    // Married Filing Jointly
    return [206000, 258000, 322000, 386000, 750000];
}

async function fetchHistoricalPrices(ticker = "VTI") {
    const url = `https://hamiltondesigns.vercel.app/api/yahoo3?ticker=${ticker}&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch price data");
    return await response.json();
}

function computeReturnStats(prices) {
    prices = limitToLastNYears(prices, 10);

    if (!prices || prices.length < 2) {
        return { annualReturn: 0, annualVol: 0 };
    }

    const dailyReturns = [];

    for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1].close;
        const curr = prices[i].close;
        dailyReturns.push((curr - prev) / prev);
    }

    const avgDaily =
        dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;

    const variance =
        dailyReturns.reduce(
            (sum, r) => sum + Math.pow(r - avgDaily, 2),
            0
        ) /
        (dailyReturns.length - 1);
    const dailyVol = Math.sqrt(variance);

    const annualReturn = Math.pow(1 + avgDaily, 252) - 1;
    const annualVol = dailyVol * Math.sqrt(252);

    return { annualReturn, annualVol };
}

document
    .getElementById("overrideVolToggle")
    .addEventListener("change", e => {
        document.getElementById("customVolInputs").style.display = e.target
            .checked
            ? "block"
            : "none";
    });

function applyWithdrawals({
    age,
    roth,
    trad,
    spendingNeed,
    ssIncome,
    retireTax
}) {
    // Social Security offset (0 before claim age)
    const netNeed = Math.max(spendingNeed - ssIncome, 0);

    if (netNeed <= 0) {
        return { roth, trad };
    }

    // Withdrawal order: Traditional first (taxable), then Roth
    let remainingNeed = netNeed;

    // Traditional withdrawal (pre-tax)
    if (trad > 0) {
        const tradGross = remainingNeed / (1 - retireTax); // gross needed to net the spending
        const tradWithdrawal = Math.min(tradGross, trad);
        trad -= tradWithdrawal;
        remainingNeed -= tradWithdrawal * (1 - retireTax);
    }

    // Roth withdrawal (tax-free)
    if (remainingNeed > 0 && roth > 0) {
        const rothWithdrawal = Math.min(remainingNeed, roth);
        roth -= rothWithdrawal;
        remainingNeed -= rothWithdrawal;
    }

    return {
        roth: Math.max(roth, 0),
        trad: Math.max(trad, 0)
    };
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
/* -------------------------------------------------------
   YEARLY CURVES FOR CHART (legacy helper) and Tax helper
------------------------------------------------------- */

function buildYearlyCurves(engineYears, explicitDepletionAge) {
    return {
        labels: engineYears.map(y => y.age),

        roth: engineYears.map(y => ({
            age: y.age,
            balance: y.rothBalance
        })),

        trad: engineYears.map(y => ({
            age: y.age,
            balance: y.tradBalance
        })),

        combined: engineYears.map(y => ({
            age: y.age,
            balance: y.combinedBalance
        })),

        // Use explicit depletion age if provided; otherwise fall back to engine scan
        depletionAge: explicitDepletionAge ?? findDepletionAge(engineYears)
    };
}


function findDepletionAge(engineYears) {
    const lastPositive = engineYears
        .slice()
        .reverse()
        .find(y => y.combinedBalance > 0);

    return lastPositive ? lastPositive.age : null;
}

function buildTaxChartData(engineYears, retireTax) {
    return {
        labels: engineYears.map(y => y.age),

        // Total taxable income (RMD + extra Trad + taxable SS)
        taxableIncome: engineYears.map(y => ({
            x: y.age,
            y: y.taxableIncome || 0
        })),

        // RMD taxable income (gross RMD)
        rmdIncome: engineYears.map(y => ({
            x: y.age,
            y: y.rmdComponent
                ? Math.round(y.rmdComponent / (1 - retireTax)) // convert net RMD back to gross
                : 0
        })),

        // Taxable Social Security
        taxableSS: engineYears.map(y => ({
            x: y.age,
            y: y.taxableSS || 0
        }))
    };
}

/* -------------------------------------------------------
   WITHDRAWAL REPORT (DERIVED FROM engineYears)
------------------------------------------------------- */

function computeDepletionAges() {
    return {};
}


function computeRmdSnapshots(engineYears) {
    const get = age => engineYears.find(y => y.age === age)?.rmdComponent ?? 0;

    return {
        rmdAt73: get(73),
        rmdAt80: get(80),
        rmdAt90: get(90)
    };
}

function computeFirstYearWithdrawals(engineYears, retirementAge) {
    const yr = engineYears.find(y => y.age === retirementAge);

    return {
        tradFirstYearWithdrawal: yr?.rmdComponent ?? 0,
        rothFirstYearWithdrawal: yr?.rothWithdrawal ?? 0   // optional if you track it
    };
}

function computeRequiredWithdrawalRate(engineYears, retirementAge, spendingNeed) {
    const yr = engineYears.find(y => y.age === retirementAge);
    const balance = yr?.combinedBalance ?? 0;

    return balance > 0 ? spendingNeed / balance : 0;
}

function buildWithdrawalReport(engineYears, {
    currentAge,
    retirementAge,
    lifeExpectancy,
    spendingNeed
}) {
    const rmds = computeRmdSnapshots(engineYears);
    const firstYear = computeFirstYearWithdrawals(engineYears, retirementAge);
    const requiredRate = computeRequiredWithdrawalRate(engineYears, retirementAge, spendingNeed);

    return {
        ...rmds,
        ...firstYear,
        requiredWithdrawalRate: requiredRate,
        withdrawalStrategyLabel: "Traditional first (RMDs + spending), Roth last for flexibility and tax‑free growth."
    };
}




/* -------------------------------------------------------
   ROTH CONVERSION SIMULATION ENGINE (STEP 5)
------------------------------------------------------- */

function simulateRothConversions({
    currentTrad,
    startAge,
    endAge,
    annualConversion,
    growthRate,
    filingStatus,
    baseTaxRate
}) {
    let age = startAge;
    let trad = currentTrad;
    let totalConverted = 0;
    let totalTaxOnConversions = 0;

    while (age < endAge) {
        // grow before converting
        trad *= 1 + growthRate;

        // amount to convert this year
        const convert = Math.min(annualConversion, trad);
        trad -= convert;
        totalConverted += convert;

        // simple tax model for now (can be bracket-aware later)
        totalTaxOnConversions += convert * baseTaxRate;

        age++;
    }

    // compute RMD at 73 using IRS divisor 26.5 (approx)
    const rmdAt73 = trad / 26.5;

    return {
        tradAfterConversions: trad,
        totalConverted,
        totalTaxOnConversions,
        rmdAt73
    };
}

const $ = id => document.getElementById(id);

let growthChart = null;
let taxChart = null;

/* -------------------------------------------------------
   PHASE BUILDER (Option B)
------------------------------------------------------- */

function buildPhases(currentAge, lifeExpectancy) {
    return [
        {
            name: "Aggressive",
            startAge: currentAge,
            endAge: 50,
            color: "rgba(255, 99, 132, 0.15)"
        },
        {
            name: "Moderate",
            startAge: 50,
            endAge: 60,
            color: "rgba(255, 159, 64, 0.15)"
        },
        {
            name: "Preserve",
            startAge: 60,
            endAge: 70,
            color: "rgba(75, 192, 192, 0.15)"
        },
        {
            name: "Legacy",
            startAge: 70,
            endAge: Number(lifeExpectancy),
            color: "rgba(153, 102, 255, 0.15)"
        }
    ];
}

/* --------------------------------------------------------
  HELPER FUNCTIONS for DEPLETION Calcs
  -------------------------------------------------------*/

function findTradDepletionAge(engineYears) {
    const year = engineYears.find(y => y.tradBalance <= 0);
    return year ? year.age : null;
}

function findRothDepletionAge(engineYears) {
    const year = engineYears.find(y => y.rothBalance <= 0);
    return year ? year.age : null;
}

function findCombinedDepletionAge(engineYears) {
    const lastPositive = engineYears
        .slice()
        .reverse()
        .find(y => y.combinedBalance > 0);

    return lastPositive ? lastPositive.age : null;
}

// ⭐ Longevity Buffer Score (0–100)
function computeLongevityBufferScore(yearsUntilDepletion) {
    const score = (yearsUntilDepletion / 40) * 100;
    return Math.min(100, Math.max(0, Math.round(score)));
}

// ⭐ Spending Tier Classification
function classifySpendingTier({ requiredWithdrawalRate, yearsUntilDepletion, catastrophic, bufferScore }) {
    if (catastrophic) return "unsustainable";

    // Classic safe: low withdrawal rate + long runway
    if (requiredWithdrawalRate <= 0.04 && yearsUntilDepletion >= 35) {
        return "classic-safe";
    }

    // Elevated but supported
    if (requiredWithdrawalRate <= 0.05 && yearsUntilDepletion >= 25) {
        return "elevated-supported";
    }

    // Aggressive but still viable
    if (requiredWithdrawalRate <= 0.06 && yearsUntilDepletion >= 15) {
        return "aggressive-but-supported";
    }

    // Otherwise unsustainable
    return "unsustainable";
}

function getWhyMessages(zone) {
    if (zone === "green") {
        return [
            "Your withdrawal rate is within sustainable long‑term ranges.",
            "Your portfolio growth and Social Security work well together.",
            "Your projected depletion age leaves ample room for longevity."
        ];
    }

    if (zone === "yellow") {
        return [
            "Your withdrawal need is above the typical safe spending range.",
            "Your withdrawal rate is near the upper edge of the 4%–5% guideline.",
            "Your portfolio is doing most of the work relative to Social Security.",
            "Your projected depletion age leaves less room for longevity or market shocks."
        ];
    }

    return [
        "Your withdrawal rate exceeds sustainable levels.",
        "Your projected depletion age is inside the longevity risk window.",
        "Your retirement readiness score indicates limited resilience.",
        "Your plan may not withstand typical market variability."
    ];
}

function renderEarlyRetirementNarrative(runs) {
    const container = document.getElementById("comparison-section");
    if (!container || runs.length < 2) return;

    const base = runs[0];
    const others = runs.slice(1);

    let html = `
    <div class="comparison-narrative-card">

        <h3 class="narrative-header">Interpretation & Key Insights</h3>

        <p class="narrative-intro">
            Your retirement plan is strong in all scenarios, but the timing of Social Security creates
            very different levels of early‑retirement pressure on your portfolio.
        </p>

        <div class="narrative-differences">
`;


    others.forEach((snap) => {
        html += `
        <div class="narrative-diff-row">
            <div class="narrative-diff-age">
                Delaying Social Security to <strong>age ${snap.claimAge}</strong>
            </div>
            <div class="narrative-diff-details">
                increases the years your portfolio must fully fund retirement from 
                <strong>${base.yearsWithoutSS}</strong> to <strong>${snap.yearsWithoutSS}</strong> years,
                raising the early‑retirement burden from 
                <strong>${formatCurrency(base.earlyRetirementBurden)}</strong> to 
                <strong>${formatCurrency(snap.earlyRetirementBurden)}</strong>.
            </div>
        </div>
    `;
    });


    html += `
        </div>

        <p class="narrative-body">
            Even though your long‑term stress age and depletion age remain unchanged, the
            <strong>front‑loaded withdrawal pressure</strong> increases significantly when delaying Social Security.
            This is the period most vulnerable to market downturns — known as
            <strong>sequence‑of‑returns risk</strong>.
        </p>

        <div class="narrative-summary">
            <strong>In short:</strong> Delaying Social Security improves long‑term income and reduces withdrawal
            rates, but increases early‑retirement portfolio strain. Claiming earlier reduces that strain but
            provides a lower guaranteed benefit.
        </div>

    </div>
`;


    container.innerHTML += html;
}

function normalize(value, min, max) {
    if (max === min) return 50; // avoid divide-by-zero
    return ((value - min) / (max - min)) * 100;
}

function renderScenarioDifferences(runs) {
    const container = document.getElementById("comparison-section");
    if (!container || runs.length < 2) return;

    const base = runs[0];

    const getPortfolioAtRetirement = run =>
        (run.rothAtRetirement ?? 0) + (run.tradAtRetirement ?? 0);

    const wrapper = document.createElement("div");
    wrapper.className = "comparison-diff";

    const title = document.createElement("h3");
    title.textContent = `Differences vs ${base.label || "Scenario 1"}`;
    wrapper.appendChild(title);

    runs.slice(1).forEach((run, idx) => {
        const label = run.label || `Scenario ${idx + 2}`;
        const basePortfolio = getPortfolioAtRetirement(base);
        const runPortfolio = getPortfolioAtRetirement(run);

        const stressDiff = (run.stressAge ?? 0) - (base.stressAge ?? 0);
        const depletionDiff = (run.portfolioDepletionAge ?? 0) - (base.portfolioDepletionAge ?? 0);
        const withdrawalRateDiff = (run.requiredWithdrawalRate ?? 0) - (base.requiredWithdrawalRate ?? 0);
        const ssDiff = (run.ssAtClaimAge ?? 0) - (base.ssAtClaimAge ?? 0);
        const portfolioDiff = runPortfolio - basePortfolio;
        const spendingGapDiff = (run.spendingGap ?? 0) - (base.spendingGap ?? 0);
        const yearsNoSSDiff = (run.yearsWithoutSS ?? 0) - (base.yearsWithoutSS ?? 0);
        const burdenDiff = (run.earlyRetirementBurden ?? 0) - (base.earlyRetirementBurden ?? 0);

        const col = document.createElement("div");
        col.className = "comparison-column";

        let diffHtml = `<h4>${label} vs ${base.label || "Scenario 1"}</h4>`;
        diffHtml += `<div class="comparison-section-header">Retirement Metrics</div>`;

        let pressureHtml = "";

        // Helper to add rows only when diff ≠ 0
        function addRow(target, label, value, formatter = v => v) {
            if (value !== 0 && value !== null && value !== undefined) {
                target += `<p><strong>${label}:</strong> ${formatter(value)}</p>`;
            }
            return target;
        }

        // Add only meaningful differences
        diffHtml = addRow(diffHtml, "Stress Age: ", stressDiff, v => (v > 0 ? "+" + v : v));
        diffHtml = addRow(diffHtml, "Depletion Age: ", depletionDiff, v => (v > 0 ? "+" + v : v));
        diffHtml = addRow(diffHtml, "Withdrawal Rate: ", withdrawalRateDiff, v => formatPercent(v));
        diffHtml = addRow(diffHtml, "SS Income: ", ssDiff, v => formatCurrency(v));
        diffHtml = addRow(diffHtml, "Portfolio at Retirement: ", portfolioDiff, v => formatCurrency(v));
        diffHtml = addRow(diffHtml, "Portfolio Withdrawal Need: ", spendingGapDiff, v => formatCurrency(v));

        // Early‑retirement pressure section
        pressureHtml = addRow(pressureHtml, "Years Without SS: ", yearsNoSSDiff, v => (v > 0 ? "+" + v : v));
        pressureHtml = addRow(pressureHtml, "Early-Retirement Burden: ", burdenDiff, v => formatCurrency(v));

        if (pressureHtml.trim() !== "") {
            diffHtml += `<hr><h4>Early-Retirement Pressure: </h4>${pressureHtml}`;
        }

        col.innerHTML = diffHtml;



        wrapper.appendChild(col);
    });

    container.appendChild(wrapper);
}

function computeRecommendedClaimAge(scenarios) {
    if (!scenarios || scenarios.length === 0) return null;

    // Extract arrays for normalization
    const burdens = scenarios.map(s => s.earlyRetirementBurden);
    const withdrawalRates = scenarios.map(s => s.requiredWithdrawalRate);
    const ssIncomes = scenarios.map(s => s.ssAtClaimAge);

    const minBurden = Math.min(...burdens);
    const maxBurden = Math.max(...burdens);

    const minWR = Math.min(...withdrawalRates);
    const maxWR = Math.max(...withdrawalRates);

    const minSS = Math.min(...ssIncomes);
    const maxSS = Math.max(...ssIncomes);

    // Weights (advisor-grade)
    const riskWeight = 0.45;     // early-retirement burden
    const safetyWeight = 0.35;   // withdrawal rate
    const securityWeight = 0.20; // SS income

    let bestScenario = null;
    let bestScore = -Infinity;

    scenarios.forEach(s => {
        // RISK: lower burden = better → invert scale
        const riskScore = 100 - normalize(s.earlyRetirementBurden, minBurden, maxBurden);

        // SAFETY: lower withdrawal rate = better → invert scale
        const safetyScore = 100 - normalize(s.requiredWithdrawalRate, minWR, maxWR);

        // SECURITY: higher SS income = better
        const securityScore = normalize(s.ssAtClaimAge, minSS, maxSS);

        const totalScore =
            (riskScore * riskWeight) +
            (safetyScore * safetyWeight) +
            (securityScore * securityWeight);

        s.recommendationScore = totalScore;

        if (totalScore > bestScore) {
            bestScore = totalScore;
            bestScenario = s;
        }
    });

    return bestScenario ? bestScenario.claimAge : null;
}

function renderRecommendedClaimAge(runs) {
    const container = document.getElementById("comparison-section");
    if (!container || runs.length < 2) return;

    const recommendedAge = computeRecommendedClaimAge(runs);
    if (!recommendedAge) return;

    const box = document.createElement("div");
    box.className = "recommended-claim-age-box";

    box.innerHTML = `
        <div class="recommended-claim-age-card">

            <h2 class="recommended-header">Recommended Social Security Claim Age</h2>

            <div class="recommended-age-display">
                <span class="recommended-age-value">${recommendedAge}</span>
            </div>

            <p class="intro-text">This recommendation balances three factors:</p>

            <ul class="factor-list">
                <li><strong>Early-Retirement Risk:</strong> How much strain your portfolio absorbs before Social Security begins.</li>
                <li><strong>Long-Term Sustainability:</strong> Your withdrawal rate after Social Security starts.</li>
                <li><strong>Guaranteed Income:</strong> The size of your Social Security benefit.</li>
            </ul>

            <div class="callout-block">
                <p>
                    The recommended age reflects the scenario with the strongest overall balance of 
                    <strong>risk reduction</strong>, <strong>portfolio safety</strong>, and 
                    <strong>lifetime income security</strong>. It is a purely mathematical calculation and one should factor in 
                    <strong>ALL</strong> considerations.
                </p>

                <p>
                    Refer to the 
                    <a href="https://financial-planning-toolkit.vercel.app/tools/Roth-vs-traditional-analyzer/guide.html">
                        Help/Service Guide's
                    </a> 
                    3‑Step Recipe for Choosing the Best Social Security Claim Age for additional insights.
                </p>
            </div>

        </div>
    `;

    container.appendChild(box);
}




/* -------------------------------------------------------
   MAIN RUN HANDLER
------------------------------------------------------- */

$("runBtn").addEventListener("click", async () => {
    const loading = $("loading");
    const output = $("output");
    const summary = $("summary");

    output.textContent = "";
    summary.innerHTML = "";
    loading.style.display = "block";

    

    /* ---------------------------------------------------
       INPUTS
    --------------------------------------------------- */
    // const currentRoth = parseFloat($("currentRoth").value) || 0;
    // const currentTrad = parseFloat($("currentTrad").value) || 0;

    // const contribution = parseFloat($("contribution").value) || 0;

    const currentRoth = parseFloat($("currentRoth").dataset.raw || 0);
    const currentTrad = parseFloat($("currentTrad").dataset.raw || 0);

    const contribution = parseFloat($("contribution").dataset.raw || 0);

    const currentTax = (parseFloat($("currentTax").value) || 0) / 100;
    let retireTax = (parseFloat($("retireTax").value) || 0) / 100;

    const growth = (parseFloat($("growth").value) || 0) / 100;
    const lifeExpectancy = 120;

    // Sanitize portfolio string
    let portfolioStr = $("portfolio").value;
    portfolioStr = portfolioStr.replace(/[\s\u200B-\u200D\uFEFF]/g, "");

    const mcRuns = parseInt($("mcRuns").value) || 0;
    const useAutoTax = $("autoTax") ? $("autoTax").checked : false;

    const currentAge = $("currentAge")
        ? parseInt($("currentAge").value) || 60
        : 60;
    const retirementAge = $("retirementAge")
        ? parseInt($("retirementAge").value) || currentAge + 25
        : currentAge + 25;

    const years = retirementAge - currentAge;
    if (years <= 0) {
        alert("Retirement age must be greater than current age.");
        return;
    }

    const workStopAge = $("workStopAge")
        ? parseInt($("workStopAge").value) || retirementAge
        : retirementAge;
    // const ssAnnualStatement = $("ssAnnual")
    //     ? parseFloat($("ssAnnual").value) || 0
    //     : 0;
    const ssAnnualStatement = $("ssAnnual")
        ? parseFloat($("ssAnnual").dataset.raw || 0)
        : 0;

    const claimAge = $("claimAge")
        ? parseInt($("claimAge").value) || 67
        : 67;
    const filingStatus = $("filingStatus")
        ? $("filingStatus").value || "married"
        : "married";
    // const spendingNeed = $("spendingNeed")
    //     ? parseFloat($("spendingNeed").value) || 0
    //     : 0;
    const spendingNeed = $("spendingNeed")
        ? parseFloat($("spendingNeed").dataset.raw || 0)
        : 0;

    const useGlidepath = $("useGlidepath")
        ? $("useGlidepath").checked
        : false;

    let mode = "synthetic";
    let expectedReturn;
    let stockVol;

    /* ---------------------------------------------------
       INPUT GUARDRAILS
    --------------------------------------------------- */

    const ticker = $("ticker").value.trim().toUpperCase();

    // 1. BOTH fields filled → not allowed
    if (ticker !== "" && portfolioStr !== "") {
        alert("Please choose either a single ticker OR a portfolio, not both.");
        return;
    }

    // 2. PORTFOLIO contains no letters → invalid
    if (portfolioStr !== "" && !/[A-Za-z]/.test(portfolioStr)) {
        alert("Portfolio must contain tickers with weights, like VTI:60, BND:40.");
        return;
    }

    // 3. PORTFOLIO missing weights (e.g., 'VTI, BND')
    if (portfolioStr !== "" && portfolioStr.includes(",") && !portfolioStr.includes(":")) {
        alert("Each portfolio ticker needs a weight, like VTI:60.");
        return;
    }

    // 4. PORTFOLIO has exactly one ticker → user probably meant single ticker mode
    if (portfolioStr !== "") {
        const { tickers } = parsePortfolio(portfolioStr);
        if (tickers.length === 1) {
            alert(
                "It looks like you entered a single ticker in the portfolio box. Use the Ticker field instead."
            );
            return;
        }
    }

    // 5. INVALID ticker symbol (must be 1–5 letters)
    if (ticker !== "" && !/^[A-Za-z]{1,5}$/.test(ticker)) {
        alert("That doesn’t look like a valid ticker symbol.");
        return;
    }

    // 6. NO ticker + NO portfolio + NO glidepath → not a meaningful scenario
    if (!useGlidepath && ticker === "" && portfolioStr === "") {
        alert("Please enter a ticker, a portfolio, or enable Glidepath.");
        return;
    }

    /* ---------------------------------------------------
       LIFECYCLE GLIDEPATH ENGINE (EXTENDED TO LIFE EXPECTANCY)
    --------------------------------------------------- */

    let yearlyExpectedReturns = null;
    let yearlyVols = null;

    if (useGlidepath) {
        mode = "real-market-glidepath";

        try {
            const tickers = [glidepathStockTicker, glidepathBondTicker];
            const data = await getMultipleTickers(tickers, "10y", "1d");

            const stockPrices = data[glidepathStockTicker] || [];
            const bondPrices = data[glidepathBondTicker] || [];

            console.log("Glidepath raw data:", {
                stockTicker: glidepathStockTicker,
                bondTicker: glidepathBondTicker,
                stockLen: stockPrices.length,
                bondLen: bondPrices.length,
                sampleStock: stockPrices.slice(0, 3),
                sampleBond: bondPrices.slice(0, 3)
            });

            const stockReturn = stockPrices.length
                ? calculateCAGR(stockPrices)
                : growth;
            const bondReturn = bondPrices.length
                ? calculateCAGR(bondPrices)
                : growth;

            console.log("Glidepath returns:", { stockReturn, bondReturn, growth });

            const stockVolDaily = stockPrices.length
                ? Finance.stddev(
                    stockPrices.slice(1).map((p, i) => {
                        const prev = stockPrices[i].close;
                        return (p.close - prev) / prev;
                    })
                )
                : 0.15 / Math.sqrt(252);

            const bondVolDaily = bondPrices.length
                ? Finance.stddev(
                    bondPrices.slice(1).map((p, i) => {
                        const prev = bondPrices[i].close;
                        return (p.close - prev) / prev;
                    })
                )
                : 0.07 / Math.sqrt(252);

            const stockVolAnnual = stockVolDaily * Math.sqrt(252);
            const bondVolAnnual = bondVolDaily * Math.sqrt(252);

            const totalYears = lifeExpectancy - currentAge;

            yearlyExpectedReturns = [];
            yearlyVols = [];

            for (let i = 0; i < totalYears; i++) {
                const age = currentAge + i;
                const yearsLeft = retirementAge - age;

                let stockWeight, bondWeight;

                if (yearsLeft > 10) {
                    // Early-career regime (aggressive)
                    stockWeight = 1.0;
                    bondWeight = 0.0;
                } else {
                    // Late-career regime (use the same logic as getGlidepathAllocation)
                    const alloc = getGlidepathAllocation(age, retirementAge);
                    stockWeight = alloc.stockWeight;
                    bondWeight = alloc.bondWeight;
                }

                const mu = stockWeight * stockReturn + bondWeight * bondReturn;

                const sigma = Math.sqrt(
                    Math.pow(stockVolAnnual * stockWeight, 2) +
                    Math.pow(bondVolAnnual * bondWeight, 2)
                );

                yearlyExpectedReturns.push(mu);
                yearlyVols.push(sigma);
            }

            console.log("Glidepath debug:", {
                currentAge,
                retirementAge,
                yearlyExpectedReturns: yearlyExpectedReturns.slice(0, 15),
                yearlyVols: yearlyVols.slice(0, 15)
            });

            expectedReturn = yearlyExpectedReturns[0];
            stockVol = yearlyVols[0];

        } catch (err) {
            console.warn("Glidepath fetch failed, falling back:", err);
            expectedReturn = growth;
            stockVol = 0.15;
            mode = "synthetic";
            yearlyExpectedReturns = null;
            yearlyVols = null;
        }
    }

    /* ---------------------------------------------------
       REAL-MARKET RETURN (PORTFOLIO OR SINGLE TICKER)
       (Only runs when glidepath is OFF)
    --------------------------------------------------- */

    if (!useGlidepath) {
        if (portfolioStr !== "") {
            // Portfolio mode
            const { tickers, weights } = parsePortfolio(portfolioStr);

            if (tickers.length) {
                try {
                    const data = await getMultipleTickers(
                        tickers,
                        "10y",
                        "1d"
                    );
                    const weightedCagr = await computeWeightedCAGR(
                        data,
                        tickers,
                        weights
                    );
                    const weightedVol =
                        await computeWeightedVolatility(
                            data,
                            tickers,
                            weights
                        );

                    if (!isNaN(weightedCagr) && weightedCagr > 0) {
                        expectedReturn = weightedCagr;
                        stockVol = weightedVol;
                        mode = "real-market-portfolio";
                    }
                } catch (err) {
                    console.warn("Portfolio real-market fetch failed:", err);
                }
            }
        } else {
            // Single ticker mode
            const ticker = $("ticker").value.trim().toUpperCase();
            if (ticker !== "") {
                try {
                    const prices = await getHistoricalPrices(
                        ticker,
                        "10y",
                        "1d"
                    );
                    if (prices.length) {
                        expectedReturn = calculateCAGR(prices);
                        mode = "real-market";
                    }
                } catch (err) {
                    console.warn(
                        "Single-ticker real-market fetch failed:",
                        err
                    );
                }
            }
        }
    }

    /* ---------------------------------------------------
       LIVE RETURN FALLBACK (ONLY IF REAL-MARKET FAILED)
    --------------------------------------------------- */
    if (!useGlidepath && expectedReturn === undefined) {
        try {
            const ticker = $("ticker").value.trim().toUpperCase();
            const prices = await getHistoricalPrices(
                ticker || "VTI",
                "10y",
                "1d"
            );
            const stats = computeReturnStats(prices);
            expectedReturn = stats.annualReturn;
        } catch (err) {
            console.warn("Live return fallback failed:", err);
            expectedReturn = growth; // manual fallback
        }
    }

    /* ---------------------------------------------------
       VOLATILITY (override or live)
    --------------------------------------------------- */
    const overrideVol = $("overrideVolToggle").checked;

    if (overrideVol) {
        stockVol = Number($("customStockVol").value) / 100;
    } else if (!useGlidepath && stockVol === undefined) {
        try {
            const ticker = $("ticker").value.trim().toUpperCase();
            const prices = await fetchHistoricalPrices(ticker || "VTI");
            const stats = computeReturnStats(prices);
            stockVol = stats.annualVol;
        } catch (err) {
            console.warn("Volatility fetch failed, using fallback:", err);
            stockVol = 0.15;
        }
    }

    /* ---------------------------------------------------
       AUTO TAX ESTIMATION
    --------------------------------------------------- */
    let retirementTaxDetails = null;

    if (useAutoTax) {
        const yearsToRetirement = retirementAge - currentAge;
        const yearsFromRetirementToRMD = Math.max(73 - retirementAge, 0);

        retirementTaxDetails = estimateRetirementTaxRate({
            currentTrad,
            yearsToRetirement,
            yearsFromRetirementToRMD,
            growth: expectedReturn,
            ssAnnual: ssAnnualStatement,
            claimAge,
            filingStatus,
            spendingNeed
        });

        retireTax = retirementTaxDetails.estimatedRate;
    }

    /* ---------------------------------------------------
       GROWTH CALCULATIONS
    --------------------------------------------------- */
    const rothStartingFuture =
        currentRoth * Math.pow(1 + expectedReturn, years);
    const tradStartingFuturePreTax =
        currentTrad * Math.pow(1 + expectedReturn, years);
    const tradStartingFutureAfterTax =
        tradStartingFuturePreTax * (1 - retireTax);

    const rothContribution = contribution * (1 - currentTax);

    const rothFuture = Finance.compoundWithContributions({
        initial: 0,
        annualContribution: rothContribution,
        expectedReturn,
        years
    });

    const tradFuturePreTax = Finance.compoundWithContributions({
        initial: 0,
        annualContribution: contribution,
        expectedReturn,
        years
    });

    const tradFutureAfterTax = tradFuturePreTax * (1 - retireTax);

    const rothFinal = rothStartingFuture + rothFuture;
    const tradFinal = tradStartingFutureAfterTax + tradFutureAfterTax;

    /* ---------------------------------------------------
       DETERMINISTIC CHART (EXTENDED TO LIFE EXPECTANCY)
    --------------------------------------------------- */

    function buildDeterministicChart({
        currentAge,
        currentRoth,
        currentTrad,
        contribution,
        rothContribution,
        expectedReturn,
        yearlyExpectedReturns,
        yearlyVols,
        useGlidepath,
        retirementAge,
        claimAge,
        ssAnnualStatement,
        spendingNeed,
        retireTax,
        lifeExpectancy,
        filingStatus,
        inflationRate = 0.03

    }) {
        const engineYears = [];

        const totalYears = lifeExpectancy - currentAge;

        let roth = currentRoth;
        let trad = currentTrad;

        for (let i = 0; i < totalYears; i++) {
            const age = currentAge + i;

            // Determine REAL return for this year
            const inflation = inflationRate; // user‑set or default inflation
            let mu;

            // If using glidepath, convert nominal → real
            if (useGlidepath && yearlyExpectedReturns) {
                const nominal = yearlyExpectedReturns[i] ??
                    yearlyExpectedReturns[yearlyExpectedReturns.length - 1];

                mu = (1 + nominal) / (1 + inflation) - 1;
            }
            // Otherwise convert expectedReturn → real
            else {
                mu = (1 + expectedReturn) / (1 + inflation) - 1;
            }


            // Contributions BEFORE retirement
            if (age < retirementAge) {
                roth += rothContribution;
                trad += contribution;
            }

            // Withdrawals AFTER retirement (Traditional-first)
            let withdrawal = undefined;
            let taxDrag = undefined;
            let rmdComponent = 0;
            let ssIncome = age >= claimAge ? ssAnnualStatement : 0;

            let rmdGross = 0;
            let tradGrossActual = 0;

            if (age >= retirementAge) {
                const needBasedNet = Math.max(spendingNeed - ssIncome, 0);

                // Compute RMD
                if (age >= 73 && trad > 0) {
                    const divisor = getRmdDivisor(age);
                    rmdGross = trad / divisor;
                }

                const rmdNet = rmdGross * (1 - retireTax);
                const extraNeedNet = Math.max(needBasedNet - rmdNet, 0);

                // Always withdraw RMD gross from Traditional
                tradGrossActual = Math.min(trad, rmdGross);
                let tradNet = tradGrossActual * (1 - retireTax);

                rmdComponent = Math.round(tradNet);

                if (extraNeedNet > 0) {
                    const extraTradGrossNeeded = extraNeedNet / (1 - retireTax);

                    const extraTradGrossActual = Math.min(
                        trad - tradGrossActual,
                        extraTradGrossNeeded
                    );

                    const extraTradNet = extraTradGrossActual * (1 - retireTax);

                    tradGrossActual += extraTradGrossActual;
                    tradNet += extraTradNet;

                    const remainingNet = extraNeedNet - extraTradNet;
                    const rothActual = Math.min(roth, remainingNet);

                    roth -= rothActual;
                    trad -= extraTradGrossActual;

                    withdrawal = Math.round(tradNet + rothActual);
                    taxDrag = Math.round(tradGrossActual * retireTax);
                } else {
                    trad -= tradGrossActual;
                    withdrawal = Math.round(tradNet);
                    taxDrag = Math.round(tradGrossActual * retireTax);
                }
            }

            // ⭐ Apply growth AFTER withdrawals
            roth *= 1 + mu;
            trad *= 1 + mu;

            // Combined after-tax balance
            const combinedBalance = roth + trad;

            // Compute taxable SS
            const taxableSS = ssIncome > 0 ? computeTaxableSS(ssIncome, filingStatus) : 0;

            // Compute taxable income
            const taxableIncome =
                (rmdGross || 0) +
                ((tradGrossActual || 0) - (rmdGross || 0)) +
                taxableSS;

            engineYears.push({
                age,
                rothBalance: roth,
                tradBalance: trad,
                combinedBalance,
                mu,
                vol: yearlyVols ? yearlyVols[i] : undefined,
                stockWeight: useGlidepath ? getGlidepathAllocation(age, retirementAge).stockWeight : undefined,
                bondWeight: useGlidepath ? getGlidepathAllocation(age, retirementAge).bondWeight : undefined,
                contribution: age < retirementAge ? contribution : undefined,
                withdrawal,
                taxableSS,
                ssIncome,
                taxableIncome,
                taxDrag,
                rmdComponent
            });

            // ⭐ Stop early if depleted
            if (combinedBalance <= 0) break;
        }

        return engineYears;
    }

    /* ---------------------------------------------------
   BUILD & RENDER GROWTH CHART
--------------------------------------------------- */

    
    // 1. Run deterministic engine (full year-by-year output)
    const engineYears = buildDeterministicChart({
        currentAge,
        currentRoth,
        currentTrad,
        contribution,
        rothContribution,
        expectedReturn,
        yearlyExpectedReturns,
        yearlyVols,
        useGlidepath,
        retirementAge,
        claimAge,
        ssAnnualStatement,
        spendingNeed,
        retireTax,
        lifeExpectancy
    });

    // ⭐ Unified depletion ages (deterministic engine = source of truth)
    const tradDepletionAge = findTradDepletionAge(engineYears);
    const rothDepletionAge = findRothDepletionAge(engineYears);

    /* ---------------------------------------------------
       MONTE CARLO
    --------------------------------------------------- */
    let monteCarlo = null;
    const mcTicker = $("ticker").value.trim().toUpperCase();

    if (mcRuns > 0 && (mcTicker || portfolioStr)) {
        monteCarlo = await runMonteCarlo({
            ticker: mcTicker,
            portfolioStr,
            contribution,
            rothContribution,
            years,
            currentTax,
            retireTax,
            runs: mcRuns,
            currentRoth,
            currentTrad,
            expectedReturn,
            stockVolatility: stockVol,
            useGlidepath,
            yearlyExpectedReturns,
            yearlyVols
        });
    }

    /* ---------------------------------------------------
    RESULT OBJECT
 --------------------------------------------------- */
    const taxContext = retirementTaxDetails
        ? {
            currentTax,
            retireTax,
            filingStatus,
            currentAge,
            retirementAge,
            claimAge,
            rmd: retirementTaxDetails.rmd,
            taxableIncome: retirementTaxDetails.taxableIncome,
            grossIncome: retirementTaxDetails.grossIncome
        }
        : {
            currentTax,
            retireTax,
            filingStatus,
            currentAge,
            retirementAge,
            claimAge
        };
        

    const result = {
        mode,
        assumedGrowthRate: expectedReturn,
        rothFinal,
        traditionalFinal: tradFinal,
        difference: rothFinal - tradFinal,
        betterOption: rothFinal > tradFinal ? "Roth" : "Traditional",
        breakEvenTaxRate: currentTax,
        currentRoth,
        currentTrad,
        years,
        monteCarlo,
        retirementTaxDetails,
        taxContext,
        expectedReturn,
        stockVol,
        spendingNeedAtRetirement: spendingNeed,
        tradDepletionAge,
        rothDepletionAge,
        depletionAge: Math.max(tradDepletionAge || 0, rothDepletionAge || 0),
        claimAge,
        glidepath: useGlidepath
            ? {
                yearlyExpectedReturns,
                yearlyVols,
                glidepathStockTicker,
                glidepathBondTicker
            }
            : null
    };

    /* ---------------------------------------------------
   BUILD & RENDER GROWTH CHART (NOW SAFE)
--------------------------------------------------- */

    // Ensure engineYears is the actual array
    // const engineYears = result.engineYears;

    // Build curves (still used elsewhere)
    const curves = buildYearlyCurves(
        engineYears,
        result.withdrawalReport?.combinedDepletionAge ??
        result.depletionAge
    );

    // Build phases (still used elsewhere)
    const phases = buildPhases(currentAge, lifeExpectancy);

    // Render the new chart
    renderGrowthChart(engineYears, retirementAge, currentAge);



    /* ---------------------------------------------------
   BUILD & RENDER TAX CHART
--------------------------------------------------- */
    const taxData = buildTaxChartData(engineYears, retireTax);

    renderTaxChart(
        taxData,
        phases,
        currentAge,
        lifeExpectancy
    );

    /* ---------------------------------------------------
       BUILD WITHDRAWAL REPORT (NEW MODERNIZED VERSION)
    --------------------------------------------------- */
    const withdrawalReport = buildWithdrawalReport(engineYears, {
        currentAge,
        retirementAge,
        lifeExpectancy,
        spendingNeed
    });

    withdrawalReport.tradDepletionAge = tradDepletionAge;
    withdrawalReport.rothDepletionAge = rothDepletionAge;

    // ⭐ Portfolio depletion age = last year with a positive combined balance
    const lastPositive = engineYears
        .slice()
        .reverse()
        .find(y => y.combinedBalance > 0);

    withdrawalReport.combinedDepletionAge = lastPositive
        ? lastPositive.age
        : null;

    // ⭐ Align yearsUntilDepletion with deterministic engine
    withdrawalReport.yearsUntilDepletion =
        withdrawalReport.combinedDepletionAge != null
            ? withdrawalReport.combinedDepletionAge - retirementAge
            : null;


    console.log("AFTER OVERRIDE (immediately):", {
        tradDepletionAge,
        rothDepletionAge,
        combinedFromOverride: withdrawalReport.combinedDepletionAge,
        withdrawalReportSnapshot: { ...withdrawalReport }
    });


    result.withdrawalReport = withdrawalReport;

    result.engineYears = engineYears;

    console.log("withdrawalReport at summary:", result.withdrawalReport);

    // 3) compute insights
    const insights = computeProInsights(result);

    // 4) merge everything into a single object
    const full = {
        ...result,
        ...insights,
    };

    // 5) render summary with the merged object
    renderSummary(full);

    // 6) save snapshot
    const snapshot = buildScenarioSnapshot(full, insights);
    saveScenarioRun(snapshot);

    // 7) show raw output
    output.textContent = JSON.stringify(full, null, 2);

    // 8) hide loading spinner
    loading.style.display = "none";
});

/* -------------------------------------------------------
   PORTFOLIO PARSING & WEIGHTED CAGR
------------------------------------------------------- */

function parsePortfolio(str) {
    const parts = str
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    const tickers = [];
    const weights = [];

    for (const part of parts) {
        const [t, w] = part.split(":").map(s => s.trim());
        if (!t || !w) continue;
        const weight = parseFloat(w);
        if (isNaN(weight) || weight <= 0) continue;
        tickers.push(t.toUpperCase());
        weights.push(weight);
    }

    const total = weights.reduce((s, w) => s + w, 0) || 1;
    const normalized = weights.map(w => w / total);

    return { tickers, weights: normalized };
}

async function computeWeightedCAGR(data, tickers, weights) {
    let total = 0;

    for (let i = 0; i < tickers.length; i++) {
        const t = tickers[i];
        const prices = data[t] || [];
        if (!prices.length) continue;
        const cagr = calculateCAGR(prices);
        total += cagr * weights[i];
    }

    return total;
}

async function computeWeightedVolatility(data, tickers, weights) {
    const dailyReturns = {};

    // 1. Compute daily returns for each ticker
    for (let t of tickers) {
        const prices = data[t];
        const rets = [];

        for (let i = 1; i < prices.length; i++) {
            const prev = prices[i - 1].close;
            const curr = prices[i].close;
            rets.push((curr - prev) / prev);
        }

        dailyReturns[t] = rets;
    }

    // 2. Compute annualized volatility for each ticker
    const vols = {};
    for (let t of tickers) {
        const std = Finance.stddev(dailyReturns[t]);
        vols[t] = std * Math.sqrt(252); // annualize
    }

    // 3. Compute correlation matrix
    const corr = {};
    for (let i = 0; i < tickers.length; i++) {
        for (let j = i; j < tickers.length; j++) {
            const a = tickers[i];
            const b = tickers[j];

            if (i === j) {
                corr[`${a}-${b}`] = 1;
            } else {
                const c = Finance.correlation(
                    dailyReturns[a],
                    dailyReturns[b]
                );
                corr[`${a}-${b}`] = c;
                corr[`${b}-${a}`] = c;
            }
        }
    }

    // 4. Compute portfolio variance
    let variance = 0;

    for (let i = 0; i < tickers.length; i++) {
        for (let j = 0; j < tickers.length; j++) {
            const a = tickers[i];
            const b = tickers[j];
            variance +=
                weights[i] *
                weights[j] *
                vols[a] *
                vols[b] *
                corr[`${a}-${b}`];
        }
    }

    return Math.sqrt(variance);
}

const glidepathStockTicker = "FXAIX";
const glidepathBondTicker = "FXNAX";

function getGlidepathAllocation(age, retirementAge) {
    const yearsToRetirement = retirementAge - age;

    // If within 10 years of retirement, use late-career glidepath
    if (yearsToRetirement <= 10) {
        if (yearsToRetirement > 2) {
            return { stockWeight: 0.65, bondWeight: 0.35 }; // Moderate
        } else if (age < 70) {
            return { stockWeight: 0.5, bondWeight: 0.5 };   // Preserve
        } else {
            return { stockWeight: 0.35, bondWeight: 0.65 }; // Legacy
        }
    }

    // More than 10 years away → aggressive
    return { stockWeight: 1.0, bondWeight: 0.0 };
}


/* -------------------------------------------------------
   CHARTS
------------------------------------------------------- */

function renderGrowthChart(engineYears, retirementAge, currentAge) {
    const ctx = $("growthChart").getContext("2d");

    if (growthChart) growthChart.destroy();

    // Build arrays directly from engineYears
    const labels = engineYears.map(y => y.age);
    const roth = engineYears.map(y => ({ x: y.age, y: y.rothBalance }));
    const trad = engineYears.map(y => ({ x: y.age, y: y.tradBalance }));
    const combined = engineYears.map(y => ({ x: y.age, y: y.combinedBalance }));

    // Identify depletion ages
    const tradDepletionAge = engineYears.find(y => y.tradBalance <= 0)?.age ?? null;
    const rothDepletionAge = engineYears.find(y => y.rothBalance <= 0)?.age ?? null;
    const combinedDepletionAge = engineYears.find(y => y.combinedBalance <= 0)?.age ?? null;

    // Extend chart horizon +10 years beyond combined depletion
    const lastAge = engineYears.at(-1).age;
    const horizon = (combinedDepletionAge ?? lastAge) + 10;

    // Build annotation objects
    const annotations = {};

    // Retirement marker
    annotations.retirementLine = {
        type: "line",
        xMin: retirementAge,
        xMax: retirementAge,
        borderColor: "#1976d2",
        borderWidth: 1.5,
        borderDash: [6, 4],
        label: {
            enabled: true,
            content: `Retirement (${retirementAge})`,
            position: "start",
            backgroundColor: "#1976d2",
            color: "#fff"
        }
    };

    // Traditional depletion marker
    if (tradDepletionAge) {
        annotations.tradDepletion = {
            type: "line",
            xMin: tradDepletionAge,
            xMax: tradDepletionAge,
            borderColor: "#b36b00",
            borderWidth: 1.5,
            borderDash: [6, 4],
            label: {
                enabled: true,
                content: `Traditional depleted (${tradDepletionAge})`,
                position: "center",
                backgroundColor: "#b36b00",
                color: "#fff"
            }
        };
    }

    // Roth depletion marker
    if (rothDepletionAge) {
        annotations.rothDepletion = {
            type: "line",
            xMin: rothDepletionAge,
            xMax: rothDepletionAge,
            borderColor: "#1a7f37",
            borderWidth: 1.5,
            borderDash: [6, 4],
            label: {
                enabled: true,
                content: `Roth depleted (${rothDepletionAge})`,
                position: "center",
                backgroundColor: "#1a7f37",
                color: "#fff"
            }
        };
    }

    // Combined depletion marker
    if (combinedDepletionAge) {
        annotations.combinedDepletion = {
            type: "line",
            xMin: combinedDepletionAge,
            xMax: combinedDepletionAge,
            borderColor: "#d32f2f",
            borderWidth: 1.5,
            borderDash: [6, 4],
            label: {
                enabled: true,
                content: `Combined depleted (${combinedDepletionAge})`,
                position: "start",
                backgroundColor: "#d32f2f",
                color: "#fff"
            }
        };
    }

    // Build the chart
    growthChart = new Chart(ctx, {
        type: "line",

        data: {
            labels,
            datasets: [
                {
                    label: "Combined (after-tax)",
                    data: combined,
                    borderColor: "#1f6feb",
                    backgroundColor: "rgba(31, 111, 235, 0.08)",
                    borderWidth: 2,
                    tension: 0.25
                },
                {
                    label: "Traditional (after-tax, after RMDs)",
                    data: trad,
                    borderColor: "#b36b00",
                    backgroundColor: "rgba(179, 107, 0, 0.05)",
                    borderWidth: 1.5,
                    borderDash: [4, 4],
                    tension: 0.25
                },
                {
                    label: "Roth (tax-free)",
                    data: roth,
                    borderColor: "#1a7f37",
                    backgroundColor: "rgba(26, 127, 55, 0.05)",
                    borderWidth: 1.5,
                    tension: 0.25
                }
            ]
        },

        options: {
            responsive: true,

            plugins: {
                // Your existing shading plugin
                phaseShading: { phases: [] },

                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
                        }
                    }
                },

                annotation: { annotations }
            },

            scales: {
                x: {
                    type: "linear",
                    min: currentAge,
                    max: horizon,
                    title: { text: "Age", display: true }
                },
                y: {
                    title: { text: "After-tax balance ($)", display: true },
                    ticks: {
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        },

        plugins: [phaseShadingPlugin]
    });
}



function renderTaxChart({
    contribution,
    expectedReturn,
    years,
    currentTax,
    rothFinal
}) {
    const ctx = $("taxChart").getContext("2d");

    const labels = [];
    const tradValues = [];

    for (let t = 0; t <= 50; t += 1) {
        const retireTax = t / 100;
        let tradBal = 0;

        for (let year = 1; year <= years; year++) {
            tradBal = tradBal * (1 + expectedReturn) + contribution;
        }

        const afterTax = tradBal * (1 - retireTax);
        labels.push(`${t}%`);
        tradValues.push(afterTax);
    }

    if (taxChart) taxChart.destroy();

    taxChart = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Traditional After-Tax Final Value",
                    data: tradValues,
                    borderColor: "#e53e3e",
                    backgroundColor: "rgba(229,62,62,0.1)",
                    tension: 0.2
                },
                {
                    label: "Roth Final (Flat Line)",
                    data: tradValues.map(() => rothFinal),
                    borderColor: "#2b6cb0",
                    borderDash: [5, 5],
                    tension: 0
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: "bottom" }
            },
            scales: {
                y: {
                    ticks: {
                        callback: v => formatCurrency(v)
                    }
                }
            }
        }
    });
}

/* -------------------------------------------------------
   MONTE CARLO SIMULATION (Volatility-Driven)
------------------------------------------------------- */

async function runMonteCarlo({
    ticker,
    portfolioStr,
    contribution,
    rothContribution,
    years,
    currentTax,
    retireTax,
    runs,
    currentRoth,
    currentTrad,
    expectedReturn,
    stockVolatility,
    useGlidepath,
    yearlyExpectedReturns: gpReturns,
    yearlyVols: gpVols
}) {
    if (!expectedReturn || !stockVolatility) return null;

    const daysPerYear = 252;
    const totalDays = years * daysPerYear;

    function getDailyParams(dayIndex) {
        if (useGlidepath && gpReturns && gpVols) {
            const yearIndex = Math.floor(dayIndex / daysPerYear);
            const mu = gpReturns[yearIndex];
            const sigma = gpVols[yearIndex];
            return {
                dailyMean: mu / daysPerYear,
                dailyStd: sigma / Math.sqrt(daysPerYear)
            };
        }

        return {
            dailyMean: expectedReturn / daysPerYear,
            dailyStd: stockVolatility / Math.sqrt(daysPerYear)
        };
    }

    const rothResults = [];
    const tradResults = [];

    function randomNormal() {
        const u1 = Math.random();
        const u2 = Math.random();
        return (
            Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        );
    }

    for (let run = 0; run < runs; run++) {
        let rothBal = currentRoth;
        let tradBal = currentTrad;

        for (let day = 0; day < totalDays; day++) {
            const z = randomNormal();

            const { dailyMean, dailyStd } = getDailyParams(day);
            const r = dailyMean + dailyStd * z;

            rothBal *= 1 + r;
            tradBal *= 1 + r;

            if (day % 21 === 0) {
                rothBal += rothContribution / 12;
                tradBal += contribution / 12;
            }
        }

        rothResults.push(rothBal);
        tradResults.push(tradBal * (1 - retireTax));
    }

    const summarize = arr => {
        const sorted = [...arr].sort((a, b) => a - b);
        const pct = p => sorted[Math.floor(p * (sorted.length - 1))];
        return {
            p10: pct(0.1),
            p50: pct(0.5),
            p90: pct(0.9)
        };
    };

    const rothSummary = summarize(rothResults);
    const tradSummary = summarize(tradResults);

    const rothWins = rothResults.filter(
        (v, i) => v > tradResults[i]
    ).length;
    const rothWinProb = (rothWins / runs) * 100;

    return {
        runs,
        roth: rothSummary,
        traditional: tradSummary,
        rothWinProbability: rothWinProb
    };
}

/* -------------------------------------------------------
   GENERATE GUIDANCE
------------------------------------------------------- */

function generateGuidance(result) {
    const items = [];

    const {
        currentRoth,
        currentTrad,
        breakEvenTaxRate,
        years,
        retirementTaxDetails
    } = result;

    if (!retirementTaxDetails) {
        return [
            {
                type: "neutral",
                text: "No guidance available for this scenario."
            }
        ];
    }

    const {
        rmd,
        ssAtClaimAge,
        estimatedRate,
        otherWithdrawals
    } = retirementTaxDetails;

    const currentTaxRate = breakEvenTaxRate * 100;

    if (currentTrad > currentRoth * 2) {
        items.push({
            type: "warning",
            text: "Your Traditional IRA is much larger than your Roth. This means future RMDs will be significant and will drive most of your taxable income in retirement."
        });
    }

    if (estimatedRate * 100 > currentTaxRate) {
        items.push({
            type: "info",
            text: "Your retirement tax rate is higher than your current tax rate. Paying taxes now (Roth) is normally more efficient — but your short time horizon changes the math."
        });
    }

    if (years < 10) {
        items.push({
            type: "neutral",
            text: "You are close to retirement, so Roth contributions have limited time to grow. Traditional contributions often produce higher after-tax value in short horizons."
        });
    }

    if (rmd > 100000) {
        items.push({
            type: "warning",
            text: "Your Required Minimum Distributions (RMDs) will be large enough to push you into higher tax brackets."
        });
    }

    if (otherWithdrawals > 0) {
        items.push({
            type: "neutral",
            text: "Your spending needs exceed your RMD, which means you will withdraw additional taxable income each year."
        });
    }

    if (ssAtClaimAge < 40000) {
        items.push({
            type: "info",
            text: "Claiming Social Security early reduces your benefit and increases the percentage that becomes taxable."
        });
    }

    return items;
}

function getIrsDivisor(age) {
    if (age < 73) return null;

    const table = {
        73: 26.5,
        74: 25.5,
        75: 24.6,
        76: 23.7,
        77: 22.9,
        78: 22.0,
        79: 21.1,
        80: 20.2,
        81: 19.4,
        82: 18.5,
        83: 17.7,
        84: 16.8,
        85: 16.0,
        86: 15.2,
        87: 14.4,
        88: 13.7,
        89: 12.9,
        90: 12.2
    };

    return table[age] ?? 12.2; // fallback for 90+
}


/* -------------------------------------------------------
   PRO INSIGHTS (COMPUTATION)
------------------------------------------------------- */

function computeProInsights(result) {
    let catastrophic = null;
    let spendingNeedAtRetirement = null;
    let fourPercent = null;
    let fivePercent = null;
    let retirementReadiness = null;
    let requiredWithdrawalRate = null;
    let spendingGap = null;
    let yearsUntilDepletion = null;
    let depletionAge = null;
    let retirementBalance = 0;
    let safeSpendingMin = null;
    let safeSpendingMax = null;
    let safeSpendingDelta = null;
    let requiredPortfolioSize = null;

    let tradDepletionAge = null;          // declare only
    let rothDepletionAge = null;          // declare only
    let tradFirstYearWithdrawal = result.retirementTaxDetails?.rmd ?? 0;
    let rothFirstYearWithdrawal = null;

    let tradRmdAt73 = null;
    let tradRmdAt80 = null;
    let tradRmdAt90 = null;
    // let rothAtRetirement = result.rothAtRetirement ?? 0;
    let rothAtRetirement = result.rothAtRetirement ?? result.currentRoth ?? 0;
    let rothFirstWithdrawalAge = tradDepletionAge;

    let sustainabilityFailureAge = null;


    let withdrawalStrategyLabel = "Traditional first (RMDs + spending), Roth last for flexibility and tax‑free growth.";

    let zone = null;

    const glidepath = result.glidepath?.yearlyExpectedReturns || null;

    const growthRate = result.expectedReturn ?? 0.05;
    const startAge = result.taxContext?.retirementAge ?? 65;

    // let tradAtRetirement = result.retirementTaxDetails?.tradAtRetirement ?? 0;
    let tradAtRetirement = result.retirementTaxDetails?.tradAtRetirement ?? result.currentTrad ?? 0;
    let tradBalance = tradAtRetirement;
    let rothBalance = rothAtRetirement;

    function simulateTradDepletion(startBalance, startAge, spendingNeed, growthRate) {
        let age = startAge;
        let balance = startBalance;

        while (balance > 0 && age < 120) {
            const divisor = getIrsDivisor(age);
            const rmd = divisor ? balance / divisor : 0;

            const withdrawal = Math.max(rmd, spendingNeed);

            balance = balance - withdrawal;
            balance = balance * (1 + growthRate);

            age++;
        }

        return age;
    }

    function simulateRothDepletion(startBalance, startAge, spendingNeed, growthRate) {
        let age = startAge;
        let balance = startBalance;

        while (balance > 0 && age < 120) {
            balance = balance - spendingNeed;
            balance = balance * (1 + growthRate);
            age++;
        }

        return age;
    }

    function computeRmd(balance, age) {
        const divisor = getIrsDivisor(age);
        return divisor ? balance / divisor : 0;
    }

    tradRmdAt73 = computeRmd(tradBalance, 73);
    tradRmdAt80 = computeRmd(tradBalance, 80);
    tradRmdAt90 = computeRmd(tradBalance, 90);

    function simulateWithdrawal(balance, rate, growthRate, years) {
        const annual = balance * rate;
        let b = balance;

        for (let i = 0; i < years; i++) {
            b = b * (1 + growthRate) - annual;
            if (b <= 0) return 0;
        }
        return b;
    }

    function runReadinessMonteCarlo({
        startingBalance,
        annualWithdrawal,
        years,
        meanGrowth = 0.05,
        stdev = 0.12,
        simulations = 500,
        readinessThreshold = 500000
    }) {
        let successCount = 0;

        for (let i = 0; i < simulations; i++) {
            let balance = startingBalance;

            for (let y = 0; y < years; y++) {
                const rand = Math.random();
                const z =
                    Math.sqrt(-2 * Math.log(rand)) *
                    Math.cos(2 * Math.PI * rand);
                const growth = meanGrowth + stdev * z;

                balance = balance * (1 + growth) - annualWithdrawal;
                if (balance <= 0) {
                    balance = 0;
                    break;
                }
            }

            if (balance >= readinessThreshold) {
                successCount++;
            }
        }

        return Math.round((successCount / simulations) * 100);
    }

    function withdrawalInsight(balance, rate, growthRate, years) {
        const endBalance = simulateWithdrawal(
            balance,
            rate,
            growthRate,
            years
        );

        const ratio = endBalance / balance;

        let label;
        if (ratio >= 0.5) label = "Sustainable";
        else if (ratio >= 0.1) label = "Borderline";
        else if (ratio > 0) label = "High Risk";
        else label = "Not Sustainable";

        return {
            rate,
            annual: balance * rate,
            endBalance,
            ratio,
            label
        };
    }

    const { currentRoth, currentTrad, retirementTaxDetails, taxContext } =
        result;

    const total = currentRoth + currentTrad || 1;
    const rothShare = currentRoth / total;

    const diversificationScore = Math.round(
        100 * (1 - Math.abs(rothShare - 0.5) / 0.5)
    );

    let rmdPressureScore = null;
    let conversionWindow = null;
    let conversionComment = null;
    let irmaaRiskScore = null;
    let bracketFillAmount = null;
    let bracketFillRate = null;
    let taxTrajectory = null;
    let safeConversionMin = null;
    let safeConversionMax = null;
    let conversionImpact = null;
    let maxConversion = null;
    let currentBracketFill = null;
    let nextBracketFill = null;
    let currentBracketRate = null;
    let nextBracketRate = null;
    let taxJump = null;

    if (retirementTaxDetails && taxContext) {
        const { rmd, tradAt73, estimatedRate } = retirementTaxDetails;
        const {
            filingStatus,
            taxableIncome,
            grossIncome,
            currentTax,
            retireTax,
            retirementAge,
            currentAge
        } = taxContext;

        rothAtRetirement = result.currentRoth;
        const yearsToRetirement = taxContext.retirementAge - taxContext.currentAge;
        const growth = result.expectedReturn ?? 0.05;

        for (let i = 0; i < yearsToRetirement; i++) {
            rothAtRetirement *= (1 + growth);
        }

        rothBalance = rothAtRetirement;


        const rmdFactor = Math.min(rmd / 100000, 2);
        const tradFactor = Math.min(tradAt73 / 2000000, 2);
        const taxFactor = estimatedRate / 0.22;

        const raw = (rmdFactor + tradFactor + taxFactor) / 3;
        rmdPressureScore = Math.round(
            Math.max(0, Math.min(100, raw * 60))
        );

        conversionWindow = `${retirementAge}–73`;

        if (rmdPressureScore >= 70) {
            conversionComment =
                "High RMD pressure. Consider steady annual Roth conversions to reduce future RMDs and taxable income.";
        } else if (rmdPressureScore >= 40) {
            conversionComment =
                "Moderate RMD pressure. Targeted Roth conversions in lower-income years can improve flexibility.";
        } else {
            conversionComment =
                "Low RMD pressure. Roth conversions are optional and may be most useful for legacy or flexibility goals.";
        }

        const { brackets } = getBracketThresholds({ filingStatus });

        const taxable = Math.max(taxableIncome, 0);
        const currentBracket =
            brackets.find(b => taxable <= b.top) ||
            brackets[brackets.length - 1];
        const nextBracketIndex = brackets.indexOf(currentBracket) + 1;
        const nextBracket = brackets[nextBracketIndex];

        if (nextBracket) {
            const space = Math.max(nextBracket.top - taxable, 0);
            bracketFillAmount = Finance.round(space);
            bracketFillRate = currentBracket.rate;
        }

        if (currentBracket) {
            currentBracketRate = currentBracket.rate;
            currentBracketFill = Math.max(
                currentBracket.top - taxable,
                0
            );

            if (nextBracket) {
                nextBracketFill = Math.max(
                    nextBracket.top - taxable,
                    0
                );
                nextBracketRate = nextBracket.rate;
                taxJump = nextBracketRate - currentBracketRate;
            }
        }

        const irmaaThresholds = getIrmaaThresholds({ filingStatus });
        const magi = grossIncome;

        let band = 0;
        for (let i = 0; i < irmaaThresholds.length; i++) {
            if (magi > irmaaThresholds[i]) band = i + 1;
        }

        irmaaRiskScore = Math.min(100, band * 20);

        let irmaaHeadroom = null;
        const nextIrmaa = irmaaThresholds.find(t => magi < t);
        if (nextIrmaa) {
            irmaaHeadroom = Math.max(nextIrmaa - magi, 0);
        }

        if (bracketFillAmount !== null) {
            const maxByBracket = bracketFillAmount;
            const maxByIrmaa =
                irmaaHeadroom !== null ? irmaaHeadroom : maxByBracket;
            const safeMax = Math.max(
                0,
                Math.min(maxByBracket, maxByIrmaa)
            );

            safeConversionMin = 0;
            safeConversionMax = Finance.round(safeMax);
        }

        if (safeConversionMax !== null && safeConversionMax > 0) {
            const startAge = retirementAge;
            const endAge = 73;
            const annualConversion = safeConversionMax;

            const conversionGrowthRate =
                parseFloat(result.assumedGrowthRate) || 0.07;

            const baseTaxRate = currentTax;

            const sim = simulateRothConversions({
                currentTrad,
                startAge,
                endAge,
                annualConversion,
                growthRate: conversionGrowthRate,
                filingStatus,
                baseTaxRate
            });

            conversionImpact = {
                annualConversion,
                tradAfter: Finance.round(sim.tradAfterConversions),
                rmdAfter: Finance.round(sim.rmdAt73),
                rmdBefore: Finance.round(rmd),
                rmdReduction: Finance.round(rmd - sim.rmdAt73)
            };
        }

        if (bracketFillAmount !== null) {
            const maxByBracket = bracketFillAmount;
            const maxByIrmaa =
                irmaaHeadroom !== null ? irmaaHeadroom : maxByBracket;
            maxConversion = Math.max(maxByBracket, maxByIrmaa);
        }

        taxTrajectory = {
            currentRate: currentTax,
            retireRate: retireTax,
            rmdRate: retireTax
        };

        const yearsTo85 = Math.max(0, 85 - retirementAge);

        let retirementGrowthRate = 0.05;

        if (Array.isArray(glidepath) && glidepath.length > 0) {
            const start = yearsToRetirement;
            const end = yearsToRetirement + yearsTo85;

            const retirementReturns = glidepath.slice(start, end);

            if (retirementReturns.length > 0) {
                retirementGrowthRate =
                    retirementReturns.reduce((sum, r) => sum + r, 0) /
                    retirementReturns.length;
            }
        }

        const yearsInRetirement = Math.max(0, 85 - retirementAge);

        retirementBalance = tradAtRetirement + rothAtRetirement;

        spendingNeedAtRetirement =
            result.spendingNeedAtRetirement ?? 0;

        requiredPortfolioSize = spendingNeedAtRetirement / 0.04;

        const ssIncome =
            result.retirementTaxDetails?.ssAtClaimAge ?? 0;
        spendingGap = spendingNeedAtRetirement - ssIncome;

        requiredWithdrawalRate =
            retirementBalance > 0
                ? spendingGap / retirementBalance
                : 1;

        // First-year withdrawals
        const firstYearRmd = result.retirementTaxDetails?.rmd ?? 0;

        // Portfolio needs to cover the spending gap
        const firstYearPortfolioWithdrawal = Math.max(spendingGap, 0);

        // Under "Traditional first", all portfolio withdrawals start from Trad
        tradFirstYearWithdrawal = Math.max(firstYearRmd, firstYearPortfolioWithdrawal);
        rothFirstYearWithdrawal = 0;

        // --- Traditional stays at 0 unless user explicitly contributes ---
        const userAllowsTradGrowth =
            result.userTradContribution > 0 ||
            result.currentTrad > 0;
        // Future options:
        // || result.employerMatchTrad > 0
        // || result.contributionDirection === "traditional"
        // || result.contributionDirection === "split"

        if (!userAllowsTradGrowth) {
            tradBalance = 0;
            tradAtRetirement = 0;
            tradDepletionAge = result.taxContext.retirementAge; // empty at retirement
            tradFirstYearWithdrawal = 0;
            tradRmdAt73 = 0;
            tradRmdAt80 = 0;
            tradRmdAt90 = 0;

            // Roth starts immediately
            rothDepletionAge = simulateRothDepletion(
                rothBalance,
                result.taxContext.retirementAge,
                spendingGap,
                growthRate
            );
        } else {
            // Normal behavior: simulate Traditional first, then Roth
            tradDepletionAge = simulateTradDepletion(
                tradBalance,
                startAge,
                spendingGap,
                growthRate
            );

            rothDepletionAge = simulateRothDepletion(
                rothBalance,
                tradDepletionAge,
                spendingGap,
                growthRate
            );
        }

        rothFirstWithdrawalAge = tradDepletionAge;

        // If Traditional is empty at retirement, Roth covers the spending gap
        if (tradAtRetirement === 0) {
            rothFirstYearWithdrawal = spendingGap;
        }


        // 4% / 5% insights
        fourPercent = withdrawalInsight(
            retirementBalance,
            0.04,
            growthRate,
            yearsInRetirement
        );

        fivePercent = withdrawalInsight(
            retirementBalance,
            0.05,
            growthRate,
            yearsInRetirement
        );

        safeSpendingMin = fourPercent?.annual ?? 0;
        safeSpendingMax = fivePercent?.annual ?? 0;

        safeSpendingDelta = spendingNeedAtRetirement - safeSpendingMax;
        if (safeSpendingDelta < 0) safeSpendingDelta = 0;

        // ⭐ Compute retirement readiness BEFORE catastrophic logic
        const mcStartingBalance = currentRoth + currentTrad;
        const mcWithdrawal = mcStartingBalance * 0.04;
        const mcYears = Math.max(0, 85 - retirementAge);
        const mcMeanGrowth = parseFloat(result.assumedGrowthRate) || 0.07;

        retirementReadiness = runReadinessMonteCarlo({
            startingBalance: mcStartingBalance,
            annualWithdrawal: mcWithdrawal,
            years: mcYears,
            meanGrowth: mcMeanGrowth,
            stdev: 0.12,
            simulations: 500,
            readinessThreshold: 500000
        });

        // ⭐ Portfolio depletion age = last account to hit zero
        const portfolioDepletionAge =
            result.withdrawalReport?.combinedDepletionAge ??
            result.depletionAge ??
            null;

        // ⭐ Assign to insights
        depletionAge = portfolioDepletionAge;

        // ⭐ Years of retirement supported (null‑safe)
        const yearsOfRetirementSupported =
            portfolioDepletionAge != null && taxContext?.retirementAge != null
                ? portfolioDepletionAge - taxContext.retirementAge
                : result.withdrawalReport?.yearsUntilDepletion ?? null;

        // ⭐ Define sustainabilityFailureAge safely
        if (tradDepletionAge != null && rothDepletionAge != null) {
            sustainabilityFailureAge = Math.min(tradDepletionAge, rothDepletionAge);
        } else if (tradDepletionAge != null) {
            sustainabilityFailureAge = tradDepletionAge;
        } else if (rothDepletionAge != null) {
            sustainabilityFailureAge = rothDepletionAge;
        }

        yearsUntilDepletion = yearsOfRetirementSupported;

        // ⭐ Catastrophic logic
        catastrophic =
            requiredWithdrawalRate > 0.06 ||
            retirementReadiness < 50 ||
            yearsUntilDepletion < 20 ||
            (sustainabilityFailureAge != null && sustainabilityFailureAge < 90);

        // Apply catastrophic overrides
        if (catastrophic) {
            fourPercent.label = "Not Sustainable";
            fourPercent.endBalance = 0;

            fivePercent.label = "Not Sustainable";
            fivePercent.endBalance = 0;
        }


        // ⭐ Simulation override: if the plan lasts to 120 with huge buffer, it's green
        const simulationStrong =
            depletionAge >= 120 &&
            yearsUntilDepletion >= 50 &&
            !catastrophic;

        zone = "green";

        // Red overrides everything
        if (catastrophic) {
            zone = "red";
        }
        // Yellow applies only if simulation is NOT overwhelmingly strong
        else if (
            !simulationStrong && (
                requiredWithdrawalRate > 0.045 ||     // near top of safe band
                safeSpendingDelta > 0 ||              // above safe spending range
                (sustainabilityFailureAge != null && sustainabilityFailureAge < 95) ||   // depletion inside longevity window
                retirementReadiness < 80              // not catastrophic, but not robust
            )
        ) {
            zone = "yellow";
        }

    }

    const bufferScore = computeLongevityBufferScore(yearsUntilDepletion);
    // const yearsWithoutSS = Math.max(result.claimAge - result.retirementAge, 0);
    // const earlyRetirementBurden = yearsWithoutSS * result.spendingNeedAtRetirement;

    // ⭐ Correct early-retirement metrics
    const claimAge = result.taxContext?.claimAge ?? null;
    const retirementAge = result.taxContext?.retirementAge ?? null;

    const yearsWithoutSS =
        claimAge != null && retirementAge != null
            ? Math.max(claimAge - retirementAge, 0)
            : 0;

    const earlyRetirementBurden =
        spendingNeedAtRetirement != null
            ? yearsWithoutSS * spendingNeedAtRetirement
            : 0;



    return {
        diversificationScore,
        rmdPressureScore,
        conversionWindow,
        conversionComment,
        irmaaRiskScore,
        bracketFillAmount,
        bracketFillRate,
        taxTrajectory,
        safeConversionMin,
        safeConversionMax,
        conversionImpact,
        maxConversion,
        currentBracketFill,
        nextBracketFill,
        currentBracketRate,
        nextBracketRate,
        taxJump,
        fourPercentInsight: fourPercent,
        fivePercentInsight: fivePercent,
        retirementReadiness,
        spendingNeedAtRetirement,
        requiredWithdrawalRate,
        spendingGap,
        portfolioDepletionAge: depletionAge,
        sustainabilityFailureAge,
        yearsOfRetirementSupported: yearsUntilDepletion,
        tradDepletionAge,
        rothDepletionAge,
        tradFirstYearWithdrawal,
        rothFirstYearWithdrawal,
        tradRmdAt73,
        tradRmdAt80,
        tradRmdAt90,
        withdrawalStrategyLabel,
        zone,
        catastrophic,
        safeSpendingMin,
        safeSpendingMax,
        safeSpendingDelta,
        requiredPortfolioSize,
        rothAtRetirement,
        tradAtRetirement,
        rothFirstWithdrawalAge,
        taxContext: result.taxContext,
        bufferScore,
        yearsWithoutSS,
        earlyRetirementBurden,

    };
}

function showSustainability(zone) {
    const pos = document.getElementById("sustain-positive");
    const yel = document.getElementById("sustain-yellow");
    const neg = document.getElementById("sustain-negative");

    // Hide all
    pos.style.display = "none";
    yel.style.display = "none";
    neg.style.display = "none";

    // Show the correct one
    if (zone === "green") {
        pos.style.display = "block";
    } else if (zone === "yellow") {
        yel.style.display = "block";
    } else {
        neg.style.display = "block";
    }

    // Force repaint (optional)
    const section = document.getElementById("sustainability-section");
    void section.offsetHeight;
}

    function renderWithdrawalStrategy(result, stressAge) {

        function findAccountDepletionAge(engineYears, field) {
            for (let i = 0; i < engineYears.length; i++) {
                if (engineYears[i][field] <= 0) {
                    return engineYears[i].age;
                }
            }
            return engineYears[engineYears.length - 1].age;
        }


        const data = result; // clarity
        const tradAge = findAccountDepletionAge(data.engineYears, "tradBalance");
        const rothAge = findAccountDepletionAge(data.engineYears, "rothBalance");

        const conservativeAge = Math.max(tradAge, rothAge);

        setText("withdrawal-strategy-label", data.withdrawalStrategyLabel);

        // Annual withdrawal needed = spending need – Social Security
        const ssIncome =
            data.ssAnnualStatement ??
            data.ssAtClaimAge ??
            data.retirementTaxDetails?.ssAtClaimAge ??
            0;

        const spendingNeed = data.spendingNeedAtRetirement ?? 0;
        const annualWithdrawal = spendingNeed - ssIncome;

        setText("annual-withdrawal-needed", formatCurrency(annualWithdrawal));

        // NEW: Breakdown line
        setText("ss-contribution", formatCurrency(ssIncome));
        setText("portfolio-contribution", formatCurrency(annualWithdrawal));

        // Withdrawal rate (based on starting portfolio)
        setText(
            "required-withdrawal-rate",
            formatPercent(data.requiredWithdrawalRate)
        );

        // RMD snapshots from deterministic engine
        const rmds = computeRmdSnapshots(data.engineYears);
        setText("trad-rmd-73", formatCurrency(rmds.rmdAt73));
        setText("trad-rmd-80", formatCurrency(rmds.rmdAt80));
        setText("trad-rmd-90", formatCurrency(rmds.rmdAt90));

        // Withdrawal sequencing note
        setText(
            "withdrawal-sequencing-note",
            data.withdrawalStrategyLabel
        );

        console.log("stress age:", stressAge);

        // Use the stressAge
        setText("conservative-depletion-age", `Age ${stressAge}`);


        // Theoretical depletion age (long-term average return model)
        const theoreticalAge = data.portfolioDepletionAge ?? null;

        setText(
            "theoretical-depletion-age",
            theoreticalAge ? `Age ${theoreticalAge}` : "N/A"
        );
    }

function renderChartMismatchMessage(msg) {
    const container = document.getElementById("chart-mismatch-note");
    if (!container) return;

    if (!msg) {
        container.innerHTML = "";   // ⭐ Clear old message
        return;
    }

    container.innerHTML = `
        <div class="chart-mismatch-card">
            <h3>ℹ️  ${msg.title}</h3>
            <ul>
                ${msg.bullets.map(b => `<li>${b}</li>`).join("")}
            </ul>
        </div>
    `;
}

function safeNumber(n) {
    return Number.isFinite(n) ? n : null;
}

function renderPositiveSustainability({
    depletionAge,
    yearsLeft,
    withdrawalRate,
    spendingGap,
    successRate,
    bufferScore,
    result
}) {
    const dAge = safeNumber(depletionAge);
    const yLeft = safeNumber(yearsLeft);
    const wRate = safeNumber(withdrawalRate);
    const sGap = safeNumber(spendingGap);
    const sRate = safeNumber(successRate);
    const bScore = safeNumber(bufferScore);

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("positive-title", "Your Plan Appears Sustainable");

    // Subtitle
    setText(
        "positive-subtitle",
        dAge != null && yLeft != null
            ? `Your portfolio is projected to last until age ${dAge} (about ${yLeft} years).`
            : "Your portfolio is projected to remain sustainable under current assumptions."
    );

    // Confidence bar (retirement readiness)
    const bar = document.getElementById("sustain-bar-fill");
    bar.style.width = `${Math.min(Math.max(sRate, 0), 100)}%`;

    // Key metrics
    setText("positive-withdrawal-rate", wRate != null ? formatPercent(wRate) : "—");
    setText("positive-withdrawal-need", sGap != null ? formatCurrency(sGap) : "—");
    setText("positive-ss-income", formatCurrency(ss));

    // Longevity buffer badge (if you want it here)
    if (document.getElementById("positive-buffer-score")) {
        setText("positive-buffer-score", bScore != null ? bScore : "—");

        const msg = getWhyMessages("green");

        setText("positive-why-1", msg[0]);
        setText("positive-why-2", msg[1]);
        setText("positive-why-3", msg[2]);


    }
}


function renderYellowSustainability({
    depletionAge,
    yearsLeft,
    withdrawalRate,
    spendingGap,
    bufferScore,
    result
}) {
    const dAge = safeNumber(depletionAge);
    const yLeft = safeNumber(yearsLeft);
    const wRate = safeNumber(withdrawalRate);
    const sGap = safeNumber(spendingGap);
    const bScore = safeNumber(bufferScore);

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("yellow-title", "Your Plan Is Workable, But Sensitive to Market Conditions");

    // Subtitle
    setText(
        "yellow-subtitle",
        dAge != null && yLeft != null
            ? `Your savings may be depleted near age ${dAge} (in ${yLeft} years), and the plan has limited buffer for volatility or higher‑than‑expected spending.`
            : "Your savings may be depleted during retirement, and the plan has limited buffer for volatility or higher‑than‑expected spending."
    );

    // Key metrics
    setText("yellow-withdrawal-rate", wRate != null ? formatPercent(wRate) : "—");
    setText("yellow-spending-gap", sGap != null ? formatCurrency(sGap) : "—");
    setText("yellow-ss-income", formatCurrency(ss));

    const msg = getWhyMessages("yellow");

    setText("yellow-why-1", msg[0]);
    setText("yellow-why-2", msg[1]);
    setText("yellow-why-3", msg[2]);
    setText("yellow-why-4", msg[3]);

    // Longevity buffer badge (if present in HTML)
    if (document.getElementById("yellow-buffer-score")) {
        setText("yellow-buffer-score", bScore != null ? bScore : "—");

        const badge = document.getElementById("yellow-buffer-score");
        badge.classList.remove("buffer-danger", "buffer-warning", "buffer-safe");

        if (bScore >= 80) badge.classList.add("buffer-safe");
        else if (bScore >= 60) badge.classList.add("buffer-warning");
        else badge.classList.add("buffer-danger");
    }

}

function renderNegativeSustainability({
    depletionAge,
    yearsLeft,
    withdrawalRate,
    spendingGap,
    bufferScore,
    result
}) {
    const dAge = safeNumber(depletionAge);
    const yLeft = safeNumber(yearsLeft);
    const wRate = safeNumber(withdrawalRate);
    const sGap = safeNumber(spendingGap);
    const bScore = safeNumber(bufferScore);

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("catastrophic-title", "Your Current Plan Needs Adjustment");

    // Subtitle
    setText(
        "catastrophic-subtitle",
        dAge != null && yLeft != null
            ? `Your savings may be depleted near age ${dAge} (in ${yLeft} years), indicating a high risk of running out of money in retirement.`
            : "Your savings may be depleted during retirement, indicating a high risk of running out of money."
    );

    // Key metrics
    setText("catastrophic-withdrawal-rate", wRate != null ? formatPercent(wRate) : "—");
    setText("catastrophic-spending-gap", sGap != null ? formatCurrency(sGap) : "—");
    setText("catastrophic-ss-income", formatCurrency(ss));

    // Longevity buffer badge (if present in HTML)
    if (document.getElementById("catastrophic-buffer-score")) {
        setText("catastrophic-buffer-score", bScore != null ? bScore : "—");

        const badge = document.getElementById("catastrophic-buffer-score");
        badge.classList.remove("buffer-danger", "buffer-warning", "buffer-safe");

        if (bScore >= 80) badge.classList.add("buffer-safe");
        else if (bScore >= 60) badge.classList.add("buffer-warning");
        else badge.classList.add("buffer-danger");
    }

    // Why this result occurred
    setText("catastrophic-why-1", "Your withdrawal rate exceeds sustainable levels.");
    setText("catastrophic-why-2", "Your projected depletion age is inside the longevity risk window.");
    setText("catastrophic-why-3", "Your retirement readiness score indicates limited resilience.");
    setText("catastrophic-why-4", "Your plan may not withstand typical market variability.");
}


// ⭐ Diagnostic: Detect Chart vs Depletion Mismatch
function buildChartDepletionDiagnostic({
    tradDepletionAge,
    rothDepletionAge,
    combinedDepletionAge,
    lifeExpectancy,
    currentAge,
    engineYears
}) {
    // Peak and ending combined balances for chart-shape analysis
    const peakCombined = Math.max(...engineYears.map(y => y.combinedAfterTax));
    const endCombined = engineYears[engineYears.length - 1].combinedAfterTax;

    // If the chart ends with >50% of its peak, it "looks healthy"
    const looksHealthy = endCombined > 0.5 * peakCombined;

    const result = {
        mismatchType: "none",
        explanationKey: null
    };

    // Case 1: Traditional depletes much earlier than combined
    if (tradDepletionAge && tradDepletionAge + 5 < combinedDepletionAge) {
        result.mismatchType = "trad_early_roth_late";
        result.explanationKey = "chart_mismatch_trad_early";
        return result;
    }

    // Case 2: Roth depletes much earlier than combined
    if (rothDepletionAge && rothDepletionAge + 5 < combinedDepletionAge) {
        result.mismatchType = "roth_early_trad_late";
        result.explanationKey = "chart_mismatch_roth_early";
        return result;
    }

    // Case 3: Chart looks healthy but depletion is finite
    if (combinedDepletionAge < lifeExpectancy && looksHealthy) {
        result.mismatchType = "healthy_chart_finite_depletion";
        result.explanationKey = "chart_mismatch_healthy_but_finite";
        return result;
    }

    // Case 4: Chart stays positive but depletion age is earlier
    const ageSpan = lifeExpectancy - currentAge;
    const earlyDepletion = combinedDepletionAge < currentAge + 0.8 * ageSpan;

    if (combinedDepletionAge < lifeExpectancy && endCombined > 0 && earlyDepletion) {
        result.mismatchType = "chart_positive_but_depletes_earlier";
        result.explanationKey = "chart_mismatch_positive_but_depletes";
        return result;
    }

    return result;
}

// ⭐ Messaging: Classic Safe (≤5%)
function messageClassicSafe(result) {
    const buffer = Number.isFinite(result.bufferScore)
        ? result.bufferScore
        : 0;

    return {
        title: "Sustainable Spending Level",
        bullets: [
            "Your withdrawal rate is within the classic 4% guideline, a historically sustainable range.",
            `Your portfolio is projected to remain funded for approximately ${result.yearsUntilDepletion} years (to about age ${result.depletionAge}).`,
            `Your longevity buffer score (${buffer}) indicates strong resilience against market volatility and unexpected expenses.`,
            `Your withdrawal strategy (“${result.withdrawalStrategyLabel}”) helps extend portfolio longevity by sequencing withdrawals tax‑efficiently.`
        ]
    };
}



// ⭐ Messaging: Elevated Supported (5%–7.5%)
function messageElevatedSupported(result) {
    const buffer = Number.isFinite(result.bufferScore)
        ? result.bufferScore
        : 0;

    return {
        title: "Elevated Spending — Supported by Your Portfolio",
        bullets: [
            "Your withdrawal rate is above the traditional 4–5% guideline.",
            `However, your portfolio provides a strong longevity buffer (Score: ${buffer}).`,
            `At this spending level, your savings are projected to last ${result.yearsUntilDepletion} years.`,
            `Projected depletion age: ${result.depletionAge}.`
        ]
    };
}


// ⭐ Messaging: Aggressive but Supported (>7.5% with strong buffer)
function messageAggressiveSupported(result) {
    const buffer = Number.isFinite(result.bufferScore)
        ? result.bufferScore
        : 0;

    return {
        title: "High Lifestyle Spending — Supported for Now",
        bullets: [
            "Your withdrawal rate is well above the traditional 4–5% guideline.",
            `Your portfolio is large enough to sustain this elevated lifestyle for ${result.yearsUntilDepletion} years.`,
            `Projected depletion age: ${result.depletionAge}.`,
            "This spending level is sustainable under current assumptions, but should be revisited periodically."
        ]
    };
}


// ⭐ Messaging: Unsustainable
function messageUnsustainable(result) {
    return {
        title: "Your Plan Is Not Sustainable",
        bullets: [
            "Your withdrawal need exceeds what your portfolio can support.",
            `At this spending level, your savings would last only ${result.yearsUntilDepletion} years.`,
            "Consider reducing spending, delaying retirement, or adjusting your strategy."
        ]
    };
}

// ⭐ Messaging Dispatcher
function getSpendingMessage(result) {
    const tier = classifySpendingTier(result);

    switch (tier) {
        case "classic-safe":
            return messageClassicSafe(result);
        case "elevated-supported":
            return messageElevatedSupported(result);
        case "aggressive-but-supported":
            return messageAggressiveSupported(result);
        default:
            return messageUnsustainable(result);
    }
}

// ⭐ Render Spending Message with css tiering capability

function renderSpendingMessage(insights) {
    const zone = insights.zone;

    // Force spending tier to follow sustainability zone
    let msg;
    if (zone === "green") {
        msg = messageClassicSafe(insights);
    } else if (zone === "yellow") {
        msg = messageAggressiveSupported(insights);
    } else {
        msg = messageUnsustainable(insights);
    }

    const buffer = Number.isFinite(insights.bufferScore)
        ? insights.bufferScore
        : 0;

    const titleId = `spending-title-${zone}`;
    const listId = `spending-bullets-${zone}`;

    const titleEl = document.getElementById(titleId);
    const listEl = document.getElementById(listId);

    // Hide all spending message blocks first
    ["green", "yellow", "red"].forEach(z => {
        const t = document.getElementById(`spending-title-${z}`);
        const l = document.getElementById(`spending-bullets-${z}`);
        if (t) t.style.display = "none";
        if (l) l.style.display = "none";
    });

    if (!titleEl || !listEl) return;

    // Reset tier classes
    titleEl.classList.remove(
        "tier-classic",
        "tier-elevated",
        "tier-aggressive",
        "tier-unsustainable"
    );

    // ⭐ Apply tier class based on zone
    if (zone === "green") {
        titleEl.classList.add("tier-classic");
    } else if (zone === "yellow") {
        titleEl.classList.add("tier-aggressive");
    } else {
        titleEl.classList.add("tier-unsustainable");
    }

    // Write title + buffer badge
    titleEl.innerHTML = `
        ${msg.title}
        <span class="buffer-badge ${getBufferClass(buffer)}">${buffer}</span>
    `;

    // Write bullets
    listEl.innerHTML = "";
    msg.bullets.forEach(b => {
        const li = document.createElement("li");
        li.textContent = b;
        listEl.appendChild(li);
    });

    titleEl.style.display = "block";
    listEl.style.display = "block";
}


// ⭐ Messaging: Chart Mismatch — Traditional depletes early
function messageChartTradEarly(result) {
    return {
        title: "Why the chart looks different",
        bullets: [
            "Your Traditional IRA is projected to deplete earlier than your Roth IRA.",
            "The chart shows each account separately, so when the Traditional balance drops to zero, the combined line can appear to fall sharply.",
            "However, your Roth IRA continues to support your spending for many additional years.",
            "The projected depletion age reflects your total portfolio, not just the Traditional account."
        ]
    };
}

// ⭐ Messaging: Chart Mismatch — Roth depletes early
function messageChartRothEarly(result) {
    return {
        title: "Why the chart looks different",
        bullets: [
            "Your Roth IRA is projected to deplete earlier than your Traditional IRA.",
            "The chart shows each account separately, so when the Roth balance reaches zero, the combined line may still remain positive for many years.",
            "Your Traditional IRA continues to fund your retirement after the Roth is exhausted.",
            "The projected depletion age reflects your total portfolio, not just the Roth account."
        ]
    };
}

// ⭐ Messaging: Chart Mismatch — Chart looks healthy but depletion is finite
function messageChartHealthyButFinite(result) {
    return {
        title: "Why the chart looks different",
        bullets: [
            "The chart shows a smooth projection of your after‑tax balances using average returns.",
            "Over time, required withdrawals, taxes, and spending gradually erode your portfolio, even if the line appears relatively stable for many years.",
            "The projected depletion age reflects the point at which your assets can no longer fully support your planned spending.",
            "In other words, the chart shows the path, while the depletion age shows the limit."
        ]
    };
}

// ⭐ Messaging: Chart Mismatch — Chart stays positive but depletion age is earlier
function messageChartPositiveButDepletes(result) {
    return {
        title: "Why the chart looks different",
        bullets: [
            "The chart shows your projected balances using average returns, but it does not display every detail of your withdrawal pattern, taxes, and spending.",
            "The depletion age reflects when your plan can no longer fully support your spending after accounting for taxes, required withdrawals, and longevity.",
            "Even if the chart line remains above zero at very old ages, the underlying cash‑flow math may show that your portfolio cannot reliably sustain your planned withdrawals.",
            "When this happens, you should trust the depletion age as the more conservative measure of sustainability."
        ]
    };
}

// ⭐ Messaging Dispatcher: Chart Mismatch
function getChartMismatchMessage(result) {
    const diag = result.chartDiagnostic;
    if (!diag || diag.mismatchType === "none") return null;

    switch (diag.explanationKey) {
        case "chart_mismatch_trad_early":
            return messageChartTradEarly(result);
        case "chart_mismatch_roth_early":
            return messageChartRothEarly(result);
        case "chart_mismatch_healthy_but_finite":
            return messageChartHealthyButFinite(result);
        case "chart_mismatch_positive_but_depletes":
            return messageChartPositiveButDepletes(result);
        default:
            return null;
    }
}

function renderSafeSpending(result) {
    const low = result.safeSpendingMin ?? 0;
    const high = result.safeSpendingMax ?? 0;

    const text = `${formatCurrency(low)} – ${formatCurrency(high)}`;

    setText("safe-spending-range", text);

    // Optional: add contextual tooltip or explanation
    setText(
        "safe-spending-explainer",
        "This range reflects a 4%–5% sustainable withdrawal guideline based on your projected retirement balance."
    );
}

function attachChartExplanation() {
    const el = document.getElementById("chart-explanation-note");
    if (!el) return;

    el.addEventListener("click", () => {
        alert(
            "The growth chart shows year‑by‑year projected balances, while the depletion age " +
            "comes from the sustainability engine, which includes taxes, Social Security timing, " +
            "withdrawal sequencing, and spending patterns.Because the chart uses a large Y‑axis " +
            "scale, late‑retirement balances appear to decline earlier than they actually do. " +
            "This makes the chart visually more conservative than the underlying calculations." +
            "" +
            "These two models use different assumptions, so the chart’s visual “zero point” may " +
            "not match the precise depletion age. Together, they provide a fuller picture of how " +
            "saving decisions before retirement and spending decisions during retirement influence " +
            "long‑term sustainability."
        );

    });
}

function attachTooltipHandlers() {
    const tooltipTargets = document.querySelectorAll("[data-tooltip]");

    tooltipTargets.forEach(el => {
        el.addEventListener("mouseenter", () => {
            const tip = document.createElement("div");
            tip.className = "tooltip-bubble";
            tip.textContent = el.getAttribute("data-tooltip");
            document.body.appendChild(tip);

            const rect = el.getBoundingClientRect();
            tip.style.left = `${rect.left + rect.width / 2}px`;
            tip.style.top = `${rect.top - 8}px`;

            el._tooltip = tip;
        });

        el.addEventListener("mouseleave", () => {
            if (el._tooltip) {
                el._tooltip.remove();
                el._tooltip = null;
            }
        });
    });
}


/* -------------------------------------------------------
   SUMMARY RENDERER
------------------------------------------------------- */

function getWithdrawalTooltip(label, catastrophic) {
    switch (label) {
        case "Sustainable":
            return "You maintain a strong financial buffer through age 85. Your plan shows no risk of depletion under these assumptions.";
        case "Borderline":
            return "You do not run out of money, but your balance declines meaningfully. A poor market sequence could increase risk.";
        case "High Risk":
            return "You end with very little remaining. Even mild market volatility could cause depletion before age 85.";
        case "Not Sustainable":
            return catastrophic
                ? "Your spending need is far above what your savings can support. The portfolio is projected to deplete rapidly regardless of withdrawal strategy."
                : "Your projected balance reaches zero before age 85. This withdrawal rate is not safe under current assumptions.";
        default:
            return "";
    }
}

function renderProInsights(result) {
    const el = document.getElementById("pro-insights");
    if (!el) return;

    const {
        diversificationScore,
        rmdPressureScore,
        conversionWindow,
        conversionComment,
        irmaaRiskScore,
        bracketFillAmount,
        bracketFillRate,
        taxTrajectory,
        safeConversionMin,
        safeConversionMax,
        conversionImpact,
        maxConversion,
        currentBracketFill,
        nextBracketFill,
        currentBracketRate,
        nextBracketRate,
        taxJump,
        fourPercentInsight: fourPercent,
        fivePercentInsight: fivePercent,
        retirementReadiness,
        catastrophic
    } = result;

    const fmt = (v) =>
        Number(v).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

    const retirementAge = result.taxContext?.retirementAge;

    let html = `
    <div class="pro-insights-card">
        <div class="pro-insights-header">
            <div class="pro-insights-title">Pro Insights</div>
            <div class="pro-insights-tag">Advanced</div>
        </div>

        <!-- Custom Conversion Slider -->
        <div class="pro-insights-metric">
            <div class="pro-insights-label">Custom Conversion Amount</div>
            <input id="conversionSlider" type="range" min="0" max="100000" step="1000" value="0" />
            <div id="conversionSliderValue">$0 per year</div>
            <div id="conversion-simulation"></div>
        </div>

        <!-- Assumption Note -->
        <div class="pro-insights-note">
            <em>Assumption:</em> Roth conversions are modeled from your retirement age
            (age ${retirementAge}) until age 73.
        </div>

        <!-- Warning Box -->
        <div id="conversion-warning" class="warning-box" style="display:none;">
            <strong>Warning:</strong> Converting this amount from age ${retirementAge} until age 73 may 
            <em>increase</em> your future RMDs because your retirement tax rate is higher 
            than your current tax rate. Consider limiting conversions to your retirement 
            window or adjusting the annual amount.
        </div>
    `;

    if (rmdPressureScore !== null) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">RMD Pressure Score</div>
                <div>${rmdPressureScore}/100</div>
                <div class="pro-insights-score-bar">
                    <div class="pro-insights-score-fill" style="width:${rmdPressureScore}%;"></div>
                </div>
            </div>
        `;
    }

    if (irmaaRiskScore !== null) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">IRMAA Risk Score</div>
                <div>${irmaaRiskScore}/100</div>
                <div class="pro-insights-score-bar">
                    <div class="pro-insights-score-fill" style="width:${irmaaRiskScore}%;"></div>
                </div>
            </div>
        `;
    }

    if (bracketFillAmount !== null && bracketFillAmount > 0) {
        const totalRoom = nextBracketFill;
        const roomInCurrent = currentBracketFill;
        const roomInNext = nextBracketFill - currentBracketFill;

        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Bracket Fill Opportunity</div>
                <div>
                    <strong>Total space before you spill beyond the next tax bracket:</strong>
                    $${fmt(totalRoom)}
                </div>
    
                <div class="pro-insights-note">
                    The first $${fmt(roomInCurrent)} fills the rest of the 
                    <strong>${(currentBracketRate * 100).toFixed(0)}% bucket</strong>.<br>
                    The remaining $${fmt(roomInNext)} fills the 
                    <strong>${(nextBracketRate * 100).toFixed(0)}% bucket</strong>.
                </div>
            </div>
    
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Tax Bracket Insights</div>
    
                <div>
                    <strong>Room left in the ${(currentBracketRate * 100).toFixed(0)}% bracket:</strong>
                    $${fmt(roomInCurrent)}
                </div>
    
                <div>
                    <strong>Additional room in the ${(nextBracketRate * 100).toFixed(0)}% bracket:</strong>
                    $${fmt(roomInNext)}
                </div>
    
                <div class="pro-insights-note">
                    Crossing into the next bracket increases your marginal rate from 
                    ${(currentBracketRate * 100).toFixed(0)}% to 
                    ${(nextBracketRate * 100).toFixed(0)}% 
                    (a +${(taxJump * 100).toFixed(0)}% jump).
                </div>
            </div>
        `;
    }

    if (safeConversionMax !== null && safeConversionMax > 0) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Safe Conversion Range</div>
                <div>You can likely convert up to $${fmt(safeConversionMax)} this year without leaving your current bracket or crossing the next IRMAA tier.</div>
            </div>
        `;
    }

    if (conversionImpact) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Safe Conversion Impact</div>

                <div>
                    Converting your <strong>safe maximum</strong> of 
                    $${fmt(conversionImpact.annualConversion)} per year until age 73 
                    reduces your RMD from 
                    $${fmt(conversionImpact.rmdBefore)} 
                    to 
                    $${fmt(conversionImpact.rmdAfter)} 
                    (a reduction of $${fmt(conversionImpact.rmdReduction)}).
                </div>

                <div class="pro-insights-note">
                    This scenario uses your calculated safe conversion limit 
                    (bracket + IRMAA aware).  
                    Use the slider above to explore custom conversion amounts.
                </div>
            </div>
        `;
    }

    if (taxTrajectory) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Tax Trajectory</div>
                <div>
                    Current: ${(taxTrajectory.currentRate * 100).toFixed(1)}% →
                    Retirement: ${(taxTrajectory.retireRate * 100).toFixed(1)}%
                </div>
            </div>
        `;
    }

    if (rmdPressureScore !== null) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Roth Conversion Strategy</div>
                <div><strong>${conversionWindow}</strong> — ${conversionComment}</div>
            </div>
        `;
    }

    if (fourPercent && fivePercent) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Withdrawal Rules of Thumb (4% / 5%)</div>
    
                <div class="pro-insights-note">
                    These benchmarks ignore taxes, RMDs, IRMAA, and your actual spending need.
                    They provide quick context, while your personalized plan uses full tax‑aware modeling.
                </div>
    
                <div class="withdrawal-row">
                    <div class="withdrawal-label">4% Rule</div>
                    <div class="withdrawal-value ${fourPercent.label
                .toLowerCase()
                .replace(" ", "-")}"
                         title="A simplified rule of thumb. Ignores taxes, RMDs, and spending needs.">
                        ${fourPercent.label}
                        <span class="withdrawal-sub">
                            First-year withdrawals: ${formatCurrency(fourPercent.annual)}<br>
                            Projected balance at age 85: ${formatCurrency(fourPercent.endBalance)}
                        </span>
                    </div>
                </div>
    
                <div class="withdrawal-row">
                    <div class="withdrawal-label">5% Rule</div>
                    <div class="withdrawal-value ${fivePercent.label
                .toLowerCase()
                .replace(" ", "-")}"
                         title="A simplified rule of thumb. Ignores taxes, RMDs, and spending needs.">
                        ${fivePercent.label}
                        <span class="withdrawal-sub">
                            First-year withdrawal: ${formatCurrency(fivePercent.annual)}<br>
                            Projected balance at age 85: ${formatCurrency(fivePercent.endBalance)}
                        </span>
                    </div>
                </div>
            </div>
        `;
    }

    if (retirementReadiness !== null) {
        let readinessClass = "bad";
        if (retirementReadiness >= 90) readinessClass = "good";
        else if (retirementReadiness >= 60) readinessClass = "warn";

        let readinessLabel = "Low Readiness";
        if (retirementReadiness >= 90) readinessLabel = "High Readiness";
        else if (retirementReadiness >= 60)
            readinessLabel = "Moderate Readiness";

        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Retirement Readiness Gauge</div>
    
                <div class="readiness-score ${readinessClass}">
                    ${retirementReadiness}/100
                </div>
    
                <div class="readiness-label ${readinessClass}">
                    ${readinessLabel}
                </div>
    
                <div class="readiness-bar">
                    <div class="readiness-bar-fill ${readinessClass}" style="width:${retirementReadiness}%;"></div>
                </div>
    
                <div class="pro-insights-note">
                    This gauge reflects how often your retirement plan succeeds in Monte Carlo simulations,
                    ending with at least $500,000 remaining at age 85. Higher scores indicate stronger
                    long‑term readiness and resilience.
                </div>
            </div>
        `;
    }

    html += `</div>`;
    el.innerHTML = html;

    const slider = document.getElementById("conversionSlider");
    if (slider && maxConversion !== null) {
        slider.max = maxConversion;
    }
}

function renderSummary(data) {
    const el = $("summary");

    const {
        mode,
        assumedGrowthRate,
        rothFinal,
        traditionalFinal,
        difference,
        betterOption,
        breakEvenTaxRate,
        currentRoth,
        currentTrad,
        monteCarlo,
        retirementTaxDetails,
        conversionImpact,
        spendingNeedAtRetirement,
        rothAtRetirement,
        tradAtRetirement
    } = data;

    // ⭐ FIXED: insights must be based on data
    const insights = computeProInsights(data);


    console.log("ZONE AT SUMMARY:", insights.zone);

    document.getElementById("sustain-positive").style.display = "none";
    document.getElementById("sustain-yellow").style.display = "none";
    document.getElementById("sustain-negative").style.display = "none";

    showSustainability(insights.zone);

    const section = document.getElementById("sustainability-section");

    // Force repaint (optional)
    void section.offsetHeight;

    if (insights.zone === "red") {
        // RED — only negative renderer runs
        renderNegativeSustainability({
            depletionAge: insights.portfolioDepletionAge,
            yearsLeft: insights.yearsOfRetirementSupported,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            bufferScore: insights.bufferScore,
            result: data
        });

        renderSpendingMessage(insights);
    }
    else if (insights.zone === "yellow") {
        // YELLOW — explicitly hide negative card
        document.getElementById("sustain-negative").style.display = "none";

        renderYellowSustainability({
            depletionAge: insights.portfolioDepletionAge,
            yearsLeft: insights.yearsOfRetirementSupported,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            bufferScore: insights.bufferScore,
            result: data
        });

        renderSpendingMessage(insights);
    }
    else {
        // GREEN — explicitly hide negative card
        document.getElementById("sustain-negative").style.display = "none";

        renderPositiveSustainability({
            depletionAge: insights.portfolioDepletionAge,
            yearsLeft: insights.yearsOfRetirementSupported,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            successRate: insights.retirementReadiness,
            bufferScore: insights.bufferScore,
            result: data
        });

        renderSpendingMessage(insights);
    }



    const diffLabel =
        difference >= 0 ? "Roth ahead by" : "Traditional ahead by";

    // ⭐ Combined depletion age (the ONLY depletion age we show)
    const combinedAge = data.withdrawalReport?.combinedDepletionAge
        ?? data.portfolioDepletionAge
        ?? null;

    setText(
        "combined-depletion-age",
        combinedAge ? `Age ${combinedAge}` : "N/A"
    );


    let html = `
    <div class="summary-narrative">
        <h3>Portfolio Depletion Age</h3>
        <div class="depletion-component">
            <p>Your total retirement portfolio is projected to be fully depleted around 
            <strong>age ${combinedAge}</strong>.</p>

            <p>This reflects the point at which <em>all</em> retirement accounts are exhausted, 
            assuming your current spending pattern.</p>
        </div>
`;

    const stressAge = Math.min(
        data.withdrawalReport?.tradDepletionAge ?? Infinity,
        data.withdrawalReport?.rothDepletionAge ?? Infinity
    );

    if (Number.isFinite(stressAge)) {
        html += `
        <h3>Plan Stress Age</h3>
        <div class="depletion-component warning">
            <p>Your plan begins to show stress around
                <strong>age ${stressAge}</strong>, when the first account is projected to deplete under your current withdrawal pattern.</p>

            <p>This does <em>not</em> mean your portfolio is empty at that age —
                only that your withdrawal strategy becomes less sustainable and may require adjustments.</p>
        </div>
    `;
    }

    html += `</div>`; // closes summary-narrative



    html += `
    <h3>Comparison</h3>
    <table class="summary-table">
        <tr><th>Metric</th><th>Roth</th><th>Traditional</th></tr>
        <tr>
            <td>Starting Balance</td>
            <td>${formatCurrency(currentRoth)}</td>
            <td>${formatCurrency(currentTrad)}</td>
        </tr>
        <tr>
            <td>Balance at Retirement</td>
            <td>${formatCurrency(rothFinal)}</td>
            <td>${formatCurrency(traditionalFinal)}</td>
        </tr>
        <tr>
            <td>Better Option</td>
            <td colspan="2">${betterOption}</td>
        </tr>
        <tr>
            <td>${diffLabel}</td>
            <td colspan="2">${formatCurrency(Math.abs(difference))}</td>
        </tr>
        <tr>
            <td>Assumed Growth Rate</td>
            <td colspan="2">${formatPercent(assumedGrowthRate)}</td>
        </tr>
        <tr>
            <td>Break-Even Tax Rate</td>
            <td colspan="2">${formatPercent(breakEvenTaxRate)}</td>
        </tr>
        <tr>
            <td>Mode</td>
            <td colspan="2">${mode}</td>
        </tr>
    </table>
`;



    if (retirementTaxDetails) {
        const t = retirementTaxDetails;
        html += `
        <div class="tax-estimate-section">
            <h3>Retirement Tax Estimate</h3>
            <table class="summary-table">
                <tr><td>Estimated RMD at 73</td><td>${formatCurrency(t.rmd)}</td></tr>
                <tr><td>Estimated Social Security (at claim age)</td><td>${formatCurrency(t.ssAtClaimAge)}</td></tr>
                <tr><td>Estimated Taxable Social Security</td><td>${formatCurrency(t.taxableSS)}</td></tr>
                <tr><td>Estimated Taxable Income</td><td>${formatCurrency(t.taxableIncome)}</td></tr>
                <tr><td>Estimated Retirement Tax Rate</td><td>${formatPercent(t.estimatedRate)}</td></tr>
            </table>
        </div>    
        `;
    }

    if (monteCarlo) {
        html += `
            <h3>Monte Carlo Summary (${monteCarlo.runs} runs)</h3>
            <table class="summary-table">
                <tr><th></th><th>10th %ile</th><th>Median</th><th>90th %ile</th></tr>
                <tr><td>Roth</td><td>${formatCurrency(monteCarlo.roth.p10)}</td><td>${formatCurrency(monteCarlo.roth.p50)}</td><td>${formatCurrency(monteCarlo.roth.p90)}</td></tr>
                <tr><td>Traditional</td><td>${formatCurrency(monteCarlo.traditional.p10)}</td><td>${formatCurrency(monteCarlo.traditional.p50)}</td><td>${formatCurrency(monteCarlo.traditional.p90)}</td></tr>
                <tr><td>Roth Win Probability</td><td colspan="3">${formatPercent(monteCarlo.rothWinProbability / 100)}</td></tr>
            </table>
        `;
    }

    el.innerHTML = html;

    // ⭐ FIXED: use data, not result
    const guidanceItems = generateGuidance(data);

    let guidanceHtml = "";

    for (const item of guidanceItems) {
        guidanceHtml += `
            <div class="guidance-item ${item.type}">
                ${item.type === "warning"
                ? "⚠️"
                : item.type === "info"
                    ? "💡"
                    : "⏳"} 
                ${item.text}
            </div>
        `;
    }

    guidanceHtml += `
        <div class="guidance-recommendation">
            📈 <strong>${betterOption} contributions are the stronger choice for the remainder of your working years.</strong><br>
            This recommendation is based on your balances, time horizon, and projected retirement tax rate.
        </div>

        <h4>Next Steps</h4>
        <ul>
            <li>Explore Roth conversions between ages 60–73</li>
            <li>Consider delaying Social Security to reduce taxable income</li>
            <li>Revisit Roth contributions if income drops or tax laws change</li>
        </ul>
    `;

    document.getElementById("guidance").innerHTML = guidanceHtml;

    console.log("chartDiagnostic:", data.chartDiagnostic);
    console.log("chartMsg:", getChartMismatchMessage(data));

    const chartMsg = getChartMismatchMessage(data);
    renderChartMismatchMessage(chartMsg);


    renderWithdrawalStrategy(data, stressAge);

    renderProInsights(insights);

    const slider = document.getElementById("conversionSlider");
    const sliderValue = document.getElementById("conversionSliderValue");
    const warningBox = document.getElementById("conversion-warning");

    if (slider) {
        slider.addEventListener("input", () => {
            const annualConversion = parseInt(slider.value) || 0;

            sliderValue.textContent = `$${annualConversion.toLocaleString()} per year`;

            const { currentTrad } = data;
            const { filingStatus, currentTax, retirementAge, rmd } =
                data.taxContext;

            const growthRate = data.expectedReturn || 0.07;

            const sim = simulateRothConversions({
                currentTrad,
                startAge: retirementAge,
                endAge: 73,
                annualConversion,
                growthRate,
                filingStatus,
                baseTaxRate: currentTax
            });

            renderConversionSimulation({
                annualConversion,
                startAge: retirementAge,
                rmdBefore: rmd,
                rmdAfter: Finance.round(sim.rmdAt73),
                rmdReduction: Finance.round(rmd - sim.rmdAt73)
            });

            if (
                currentTax < data.taxContext.retireTax &&
                annualConversion > 0
            ) {
                warningBox.style.display = "block";
            } else {
                warningBox.style.display = "none";
            }
        });
    }

    // ⭐ FIXED: use data
    renderSafeSpending(data);

    attachChartExplanation();
    attachTooltipHandlers();
}

function renderScenarioComparison(runs) {
    const container = document.getElementById("comparison-section");
    if (!container) return;

    const base = runs[0];

    const getPortfolioAtRetirement = run =>
        (run.rothAtRetirement ?? 0) + (run.tradAtRetirement ?? 0);

    // 1. Build grid HTML
    let html = `
        <h2>Saved Scenario Comparison</h2>
        <div class="comparison-grid">
    `;

    runs.forEach((run, idx) => {
        const portfolioAtRetirement = getPortfolioAtRetirement(run);

        html += `
            <div class="comparison-column ssa-compare-card">

                <!-- Header -->
                <h3 class="card-header">${run.label || `Scenario ${idx + 1}`}</h3>

                <!-- Optional: Key Differences Highlight -->
                <div class="key-diff">
                    <div>Withdrawal Rate: <strong>${formatPercent(run.requiredWithdrawalRate ?? 0)}</strong></div>
                    <div>SS Income: <strong>${formatCurrency(run.ssAtClaimAge ?? 0)}</strong></div>
                    <div>Years w/out SS: <strong>${run.yearsWithoutSS}</strong></div>
                </div>

                <!-- Group 1: Ages -->
                <div class="metric-group">
                    <div class="metric"><span>Current Age: </span><span>${run.currentAge ?? "N/A"}</span></div>
                    <div class="metric"><span>Retirement Age: </span><span>${run.retirementAge ?? "N/A"}</span></div>
                    <div class="metric"><span>Claim Age: </span><span>${run.claimAge ?? "N/A"}</span></div>
                </div>

                <!-- Group 2: Longevity -->
                <div class="metric-group">
                    <div class="metric"><span>Stress Age: </span><span>${run.stressAge ?? "N/A"}</span></div>
                    <div class="metric"><span>Depletion Age: </span><span>${run.portfolioDepletionAge ?? "N/A"}</span></div>
                </div>

                <!-- Group 3: Income & Spending -->
                <div class="metric-group">
                    <div class="metric"><span>SS Income: </span><span>${formatCurrency(run.ssAtClaimAge ?? 0)}</span></div>
                    <div class="metric"><span>Portfolio at Retirement: </span><span>${formatCurrency(portfolioAtRetirement)}</span></div>
                    <div class="metric"><span>Spending Need: </span><span>${formatCurrency(run.spendingNeedAtRetirement ?? 0)}</span></div>
                    <div class="metric"><span>Withdrawal Need: </span><span>${formatCurrency(run.spendingGap ?? 0)}</span></div>
                </div>

                <!-- Group 4: Readiness -->
                <div class="metric-group">
                    <div class="metric">
                        <span>Retirement Readiness: </span>
                        <span>${run.retirementReadiness != null ? formatPercent(run.retirementReadiness / 100) : "N/A"}</span>
                    </div>

                    <div class="metric">
                        <span>Longevity Buffer: </span>
                        <span class="badge badge-green">${run.bufferScore ?? "N/A"}</span>
                    </div>

                    <div class="metric">
                        <span>Zone</span>
                        <span class="badge badge-green">${run.zone ?? "N/A"}</span>
                    </div>
                </div>

                <!-- Group 5: Early Retirement Pressure -->
                <div class="metric-group">
                    <h4>Early-Retirement Pressure</h4>

                    ${
                            run.yearsWithoutSS > 0
                                ? `
                                <div class="metric"><span>Years Without SS: </span><span>${run.yearsWithoutSS}</span></div>
                                <div class="metric"><span>Burden: </span><span>${formatCurrency(run.earlyRetirementBurden)}</span></div>
                            `
                                : `
                                <div class="metric no-pressure">
                                    <span>No early-retirement pressure</span>
                                    <span class="badge badge-green">None</span>
                                </div>
                            `
                    }
                </div>


            </div>
            `;

    });

    html += `</div>`; // close comparison-grid

    // 2. Insert grid
    container.innerHTML = "";
    container.innerHTML = html;

    // 3. Recommended claim age
    renderRecommendedClaimAge(runs);

    // 4. Differences
    if (runs.length >= 2) {
        renderScenarioDifferences(runs);
    }

    // 5. Narrative
    renderEarlyRetirementNarrative(runs);
}
