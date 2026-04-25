/* ---------------------------------------------------
   GLOBAL HELPERS & FORMATTING
--------------------------------------------------- */

// Format currency consistently across UI
function formatCurrency(value) {
    if (value === null || value === undefined || isNaN(value)) return "$0.00";
    return Number(value).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Format percent consistently across UI
function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return "0.0%";
    return (value * 100).toFixed(1) + "%";
}

// Limit price history to last N years for return stats
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

// Map longevity buffer score → CSS class
function getBufferClass(score) {
    if (score >= 80) return "buffer-strong";      // deep green
    if (score >= 60) return "buffer-supported";   // advisor blue
    if (score >= 40) return "buffer-warning";     // amber
    return "buffer-danger";                       // red
}


/* ---------------------------------------------------
   IMPORTS (ENGINE + DATA)
--------------------------------------------------- */

import { Finance } from "../../../scripts/engine.js";
import { getHistoricalPrices, getMultipleTickers } from "../../../scripts/data.js";
import { calculateCAGR } from "../../../scripts/transforms.js";
import { estimateRetirementTaxRate } from "./retirement.js";


/* ---------------------------------------------------
   IRS RMD DIVISOR TABLE (Corrected + Clamped)
--------------------------------------------------- */

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

    // Beyond age 85, divisor declines gradually but never below 1
    return Math.max(1, 16 - (age - 85) * 0.7);
}


/* ---------------------------------------------------
   SOCIAL SECURITY TAXATION (Simplified IRS Model)
--------------------------------------------------- */

function computeTaxableSS(ssAnnual, filingStatus) {
    const base = filingStatus === "married" ? 32000 : 25000;
    const max = filingStatus === "married" ? 44000 : 34000;

    const provisional = ssAnnual;

    if (provisional <= base) return 0;
    if (provisional <= max) return 0.5 * (provisional - base);

    return 0.85 * (provisional - max) + 0.5 * (max - base);
}


/* ---------------------------------------------------
   TAX BRACKETS & IRMAA THRESHOLDS
--------------------------------------------------- */

function getBracketThresholds({ filingStatus }) {
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
    if (filingStatus === "single") {
        return [103000, 129000, 161000, 193000, 500000];
    }
    return [206000, 258000, 322000, 386000, 750000];
}


/* ---------------------------------------------------
   RETURN STATISTICS (10-Year Rolling)
--------------------------------------------------- */

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


/* ---------------------------------------------------
   WITHDRAWAL ENGINE (Traditional → Roth)
--------------------------------------------------- */

function applyWithdrawals({
    age,
    roth,
    trad,
    spendingNeed,
    ssIncome,
    retireTax
}) {
    const netNeed = Math.max(spendingNeed - ssIncome, 0);

    if (netNeed <= 0) {
        return { roth, trad };
    }

    let remainingNeed = netNeed;

    // Traditional withdrawals (taxable)
    if (trad > 0) {
        const tradGross = remainingNeed / (1 - retireTax);
        const tradWithdrawal = Math.min(tradGross, trad);
        trad -= tradWithdrawal;
        remainingNeed -= tradWithdrawal * (1 - retireTax);
    }

    // Roth withdrawals (tax-free)
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


/* ---------------------------------------------------
   DEPLETION HELPERS
--------------------------------------------------- */

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

// Longevity buffer score (0–100)
function computeLongevityBufferScore(yearsUntilDepletion) {
    const score = (yearsUntilDepletion / 40) * 100;
    return Math.min(100, Math.max(0, Math.round(score)));
}


/* ---------------------------------------------------
   CHART SHADING PLUGIN (Advisor‑Grade)
--------------------------------------------------- */

const eventShadingPlugin = {
    id: "eventShading",
    beforeDraw(chart, args, options) {
        const {
            ctx,
            chartArea: { top, bottom },
            scales: { x }
        } = chart;

        if (!x || !options) return;

        const {
            rmdStartAge,
            stressAge,
            combinedDepletionAge,
            lifeExpectancy,
            bufferScore
        } = options;

        ctx.save();

        // RMD shading (age 73+)
        if (rmdStartAge != null) {
            const xStart = x.getPixelForValue(rmdStartAge);
            const xEnd = x.getPixelForValue(lifeExpectancy);
            ctx.fillStyle = "rgba(255, 193, 7, 0.08)";
            ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
        }

        // Longevity buffer shading (only if buffer is strong)
        if (combinedDepletionAge != null && bufferScore >= 80) {
            const xStart = x.getPixelForValue(combinedDepletionAge);
            const xEnd = x.getPixelForValue(lifeExpectancy);
            ctx.fillStyle = "rgba(76, 175, 80, 0.06)";
            ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
        }

        // Stress age shading (first account depletion)
        if (stressAge != null) {
            const xPos = x.getPixelForValue(stressAge);
            ctx.fillStyle = "rgba(255, 152, 0, 0.10)";
            ctx.fillRect(xPos - 2, top, 4, bottom - top);
        }

        ctx.restore();
    }
};

/* -------------------------------------------------------
   DETERMINISTIC ENGINE (Single Source of Truth)
   Advisor‑Grade, Clean, No Legacy Logic
------------------------------------------------------- */

function buildDeterministicEngine({
    currentAge,
    retirementAge,
    lifeExpectancy,
    spendingNeed,
    claimAge,
    ssAnnual,
    retireTax,
    expectedReturn,
    initialRoth,
    initialTrad,
    stockWeight,
    bondWeight
}) {
    let roth = initialRoth ?? 0;
    let trad = initialTrad ?? 0;

    const engineYears = [];

    for (let age = currentAge; age <= lifeExpectancy; age++) {
        const isRetired = age >= retirementAge;

        // Social Security income (0 before claim age)
        const ssIncome = age >= claimAge ? ssAnnual : 0;

        // Spending need (0 before retirement)
        const spending = isRetired ? spendingNeed : 0;

        // Apply withdrawals (Traditional → Roth)
        const before = { roth, trad };
        const after = applyWithdrawals({
            age,
            roth,
            trad,
            spendingNeed: spending,
            ssIncome,
            retireTax
        });

        const withdrawal =
            (before.trad - after.trad) +
            (before.roth - after.roth);

        // RMD calculation (net of tax)
        let rmdComponent = 0;
        if (age >= 73 && trad > 0) {
            const divisor = getRmdDivisor(age);
            const grossRmd = trad / divisor;
            const netRmd = grossRmd * (1 - retireTax);
            rmdComponent = netRmd;
            trad -= grossRmd;
        }

        // Grow remaining balances
        roth = Math.max(0, after.roth * (1 + expectedReturn));
        trad = Math.max(0, after.trad * (1 + expectedReturn));

        const combinedBalance = roth + trad;

        engineYears.push({
            age,
            rothBalance: roth,
            tradBalance: trad,
            combinedBalance,
            withdrawal,
            rmdComponent,
            ssIncome,
            taxDrag: 0, // placeholder for future tax modeling
            stockWeight,
            bondWeight
        });
    }

    return engineYears;
}


/* -------------------------------------------------------
   WITHDRAWAL REPORT (Derived from Engine)
------------------------------------------------------- */

// RMD snapshots at key ages
function computeRmdSnapshots(engineYears) {
    const get = age => engineYears.find(y => y.age === age)?.rmdComponent ?? 0;

    return {
        rmdAt73: get(73),
        rmdAt80: get(80),
        rmdAt90: get(90)
    };
}

// First-year withdrawals at retirement
function computeFirstYearWithdrawals(engineYears, retirementAge) {
    const yr = engineYears.find(y => y.age === retirementAge);

    return {
        tradFirstYearWithdrawal: yr?.rmdComponent ?? 0,
        rothFirstYearWithdrawal: yr?.rothWithdrawal ?? 0 // optional if tracked
    };
}

// Required withdrawal rate at retirement
function computeRequiredWithdrawalRate(engineYears, retirementAge, spendingNeed) {
    const yr = engineYears.find(y => y.age === retirementAge);
    const balance = yr?.combinedBalance ?? 0;

    return balance > 0 ? spendingNeed / balance : 0;
}

// Full withdrawal report object
function buildWithdrawalReport(engineYears, {
    currentAge,
    retirementAge,
    lifeExpectancy,
    spendingNeed
}) {
    const rmds = computeRmdSnapshots(engineYears);
    const firstYear = computeFirstYearWithdrawals(engineYears, retirementAge);
    const requiredRate = computeRequiredWithdrawalRate(
        engineYears,
        retirementAge,
        spendingNeed
    );

    return {
        ...rmds,
        ...firstYear,
        requiredWithdrawalRate: requiredRate,
        withdrawalStrategyLabel:
            "Traditional first (RMDs + spending), Roth last for flexibility and tax‑free growth."
    };
}


/* -------------------------------------------------------
   ROTH CONVERSION SIMULATION ENGINE (Optional Tool)
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
        // Grow before converting
        trad *= 1 + growthRate;

        // Convert up to annual limit
        const convert = Math.min(annualConversion, trad);
        trad -= convert;
        totalConverted += convert;

        // Simple tax model (can be bracket-aware later)
        totalTaxOnConversions += convert * baseTaxRate;

        age++;
    }

    // Compute RMD at 73 using divisor 26.5
    const rmdAt73 = trad / 26.5;

    return {
        tradAfterConversions: trad,
        totalConverted,
        totalTaxOnConversions,
        rmdAt73
    };
}

/* -------------------------------------------------------
   SPENDING TIER CLASSIFICATION (Advisor‑Grade)
------------------------------------------------------- */

function classifySpendingTier({
    requiredWithdrawalRate,
    yearsUntilDepletion,
    catastrophic,
    bufferScore
}) {
    // Catastrophic depletion → always unsustainable
    if (catastrophic) return "unsustainable";

    // No depletion within horizon (120+) → treat as strong longevity
    if (yearsUntilDepletion == null && bufferScore >= 80) {
        if (requiredWithdrawalRate <= 0.035) return "conservative";
        if (requiredWithdrawalRate <= 0.045) return "supported";
        if (requiredWithdrawalRate <= 0.055) return "elevated-supported";
        if (requiredWithdrawalRate <= 0.065) return "aggressive-but-supported";
        return "unsustainable";
    }

    // If depletion exists, combine withdrawal rate + years of longevity
    const yrs = yearsUntilDepletion ?? 0;

    if (requiredWithdrawalRate <= 0.035 && yrs >= 40) return "conservative";
    if (requiredWithdrawalRate <= 0.045 && yrs >= 35) return "supported";
    if (requiredWithdrawalRate <= 0.055 && yrs >= 30) return "elevated-supported";
    if (requiredWithdrawalRate <= 0.065 && yrs >= 25) return "aggressive-but-supported";

    return "unsustainable";
}


/* -------------------------------------------------------
   WHY‑MESSAGES (Advisor‑Grade)
------------------------------------------------------- */

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


/* -------------------------------------------------------
   ADVISOR‑GRADE INSIGHTS ENGINE (Corrected + Robust)
------------------------------------------------------- */

function computeProInsights(result, context = {}) {
    const {
        spendingNeedAtRetirement,
        tradDepletionAge,
        rothDepletionAge,
        combinedDepletionAge,
        bufferScore,
        engineYears,
        withdrawalReport
    } = result;

    const currentAge = context.currentAge ?? result.currentAge;
    const retirementAge = context.retirementAge ?? result.retirementAge;

    /* ---------------------------------------------------
       1. Required withdrawal rate
    --------------------------------------------------- */

    const requiredWithdrawalRate =
        withdrawalReport?.requiredWithdrawalRate ??
        (() => {
            const retirementYear = engineYears.find(y => y.age === retirementAge);
            if (!retirementYear || retirementYear.combinedBalance <= 0) return 0;
            return spendingNeedAtRetirement / retirementYear.combinedBalance;
        })();

    /* ---------------------------------------------------
       2. Years until depletion (robust, no NaN)
    --------------------------------------------------- */

    let yearsUntilDepletion = result.yearsUntilDepletion ?? null;

    if (yearsUntilDepletion == null) {
        if (
            combinedDepletionAge == null ||
            combinedDepletionAge >= 120 ||
            currentAge == null
        ) {
            yearsUntilDepletion = null; // treat as "no depletion"
        } else {
            yearsUntilDepletion = combinedDepletionAge - currentAge;
        }
    }

    /* ---------------------------------------------------
       3. Catastrophic flag
    --------------------------------------------------- */

    const catastrophic =
        combinedDepletionAge != null &&
        combinedDepletionAge < 120 &&
        retirementAge != null &&
        combinedDepletionAge < retirementAge + 10;

    /* ---------------------------------------------------
       4. Spending tier classification
    --------------------------------------------------- */

    const spendingTier = classifySpendingTier({
        requiredWithdrawalRate,
        yearsUntilDepletion,
        catastrophic,
        bufferScore
    });

    /* ---------------------------------------------------
       5. Zone classification
    --------------------------------------------------- */

    let zone = "green";

    if (spendingTier === "elevated-supported") zone = "yellow";
    if (spendingTier === "aggressive-but-supported") zone = "yellow";
    if (spendingTier === "unsustainable") zone = "red";
    if (catastrophic) zone = "red";

    /* ---------------------------------------------------
       6. Longevity buffer tier
    --------------------------------------------------- */

    let bufferTier = "strong";
    if (bufferScore < 80) bufferTier = "supported";
    if (bufferScore < 60) bufferTier = "warning";
    if (bufferScore < 40) bufferTier = "danger";

    /* ---------------------------------------------------
       7. Readiness score (0–100)
    --------------------------------------------------- */

    let readiness = 100;

    // Withdrawal rate penalty
    if (requiredWithdrawalRate > 0.04) readiness -= 15;
    if (requiredWithdrawalRate > 0.05) readiness -= 25;
    if (requiredWithdrawalRate > 0.06) readiness -= 35;

    // Longevity penalty (only if depletion exists)
    if (yearsUntilDepletion != null) {
        if (yearsUntilDepletion < 35) readiness -= 10;
        if (yearsUntilDepletion < 25) readiness -= 20;
        if (yearsUntilDepletion < 15) readiness -= 30;
    }

    // Catastrophic penalty
    if (catastrophic) readiness -= 40;

    readiness = Math.max(0, Math.min(100, readiness));

    /* ---------------------------------------------------
       8. Why messages
    --------------------------------------------------- */

    const whyMessages = getWhyMessages(zone);

    /* ---------------------------------------------------
       9. Depletion diagnostics
    --------------------------------------------------- */

    const depletionDiagnostics = {
        tradDepletionAge,
        rothDepletionAge,
        combinedDepletionAge,
        yearsUntilDepletion,
        catastrophic
    };

    /* ---------------------------------------------------
       10. Recommended actions
    --------------------------------------------------- */

    const recommendations = [];

    if (zone === "red") {
        recommendations.push("Reduce spending or delay retirement to improve sustainability.");
        recommendations.push("Consider partial Roth conversions to reduce future RMD pressure.");
        recommendations.push("Evaluate annuitization or guaranteed income options.");
    }

    if (zone === "yellow") {
        recommendations.push("Monitor spending closely — you are near the upper safe withdrawal range.");
        recommendations.push("Consider modest spending adjustments or delaying Social Security.");
        recommendations.push("Review asset allocation to ensure appropriate risk exposure.");
    }

    if (zone === "green") {
        recommendations.push("Your plan is well‑positioned — maintain current strategy.");
        recommendations.push("Continue monitoring RMDs and tax brackets for optimization.");
    }

    /* ---------------------------------------------------
       11. Final insights object
    --------------------------------------------------- */

    return {
        zone,
        spendingTier,
        bufferTier,
        readiness,
        requiredWithdrawalRate,
        yearsUntilDepletion,
        catastrophic,
        whyMessages,
        depletionDiagnostics,
        recommendations
    };
}


/* -------------------------------------------------------
   SUMMARY RENDERER (Advisor‑Grade)
------------------------------------------------------- */

function renderSummary(full) {
    const {
        zone,
        readiness,
        spendingTier,
        bufferTier,
        requiredWithdrawalRate,
        yearsUntilDepletion,
        depletionDiagnostics,
        whyMessages,
        recommendations
    } = full;

    const summary = $("summary");
    if (!summary) return;

    /* -------------------------------
       Zone Color
    --------------------------------*/
    let zoneColor = "#2e7d32"; // green
    if (zone === "yellow") zoneColor = "#f9a825";
    if (zone === "red") zoneColor = "#c62828";

    /* -------------------------------
       Spending Tier Label
    --------------------------------*/
    const tierLabels = {
        conservative: "Conservative Range",
        supported: "Supported Range",
        "elevated-supported": "Elevated but Supported",
        "aggressive-but-supported": "Aggressive but Supported",
        unsustainable: "Unsustainable"
    };

    const tierLabel = tierLabels[spendingTier] || spendingTier;

    /* -------------------------------
       Longevity Buffer Label
    --------------------------------*/
    const bufferLabels = {
        strong: "Strong Longevity Buffer",
        supported: "Supported Longevity Buffer",
        warning: "Warning Zone",
        danger: "Danger Zone"
    };

    const bufferLabel = bufferLabels[bufferTier] || bufferTier;

    /* -------------------------------
       HTML Output
    --------------------------------*/

    summary.innerHTML = `
        <div class="summary-zone" style="border-left: 6px solid ${zoneColor}">
            <h2>Retirement Readiness: ${readiness}/100</h2>
            <p><strong>Zone:</strong> ${zone.toUpperCase()}</p>
            <p><strong>Spending Tier:</strong> ${tierLabel}</p>
            <p><strong>Longevity Buffer:</strong> ${bufferLabel}</p>
            <p><strong>Required Withdrawal Rate:</strong> ${formatPercent(requiredWithdrawalRate)}</p>
            <p><strong>Years Until Depletion:</strong> ${yearsUntilDepletion == null ? "No depletion (120+)" : yearsUntilDepletion
        }</p>

            <h3>Why This Matters</h3>
            <ul>
                ${whyMessages.map(m => `<li>${m}</li>`).join("")}
            </ul>

            <h3>Recommended Actions</h3>
            <ul>
                ${recommendations.map(r => `<li>${r}</li>`).join("")}
            </ul>
        </div>
    `;
}

/* -------------------------------------------------------
   ADVISOR‑GRADE GROWTH CHART (V2)
   Full shading, annotations, tooltips, modern palette
------------------------------------------------------- */

let growthChart = null;
const $ = id => document.getElementById(id);

function findRothSwitchAge(engineYears) {
    for (let i = 1; i < engineYears.length; i++) {
        const prev = engineYears[i - 1];
        const curr = engineYears[i];
        if (curr.rothBalance < prev.rothBalance) {
            return curr.age;
        }
    }
    return null;
}

function findStressAge(tradDepletionAge, rothDepletionAge) {
    if (tradDepletionAge && rothDepletionAge) {
        return Math.min(tradDepletionAge, rothDepletionAge);
    }
    return tradDepletionAge || rothDepletionAge || null;
}

function buildCurvesFromEngineYears(engineYears) {
    return {
        labels: engineYears.map(y => y.age),
        roth: engineYears.map(y => ({ age: y.age, balance: y.rothBalance })),
        trad: engineYears.map(y => ({ age: y.age, balance: y.tradBalance })),
        combined: engineYears.map(y => ({ age: y.age, balance: y.combinedBalance })),
        depletionAge: engineYears.find(y => y.combinedBalance <= 0)?.age ?? null
    };
}

function renderGrowthChartV2({
    curves,
    engineYears,
    currentAge,
    lifeExpectancy,
    combinedDepletionAge,
    tradDepletionAge,
    rothDepletionAge,
    bufferScore,
    useGlidepath
}) {
    const ctx = $("growthChart").getContext("2d");
    if (growthChart) growthChart.destroy();

    const { labels, roth, trad, combined } = curves;

    const rmdStartAge = 73;
    const stressAge = findStressAge(tradDepletionAge, rothDepletionAge);
    const rothSwitchAge = findRothSwitchAge(engineYears);

    growthChart = new Chart(ctx, {
        type: "line",

        data: {
            labels,
            datasets: [
                {
                    label: "Combined (after-tax)",
                    data: combined.map(p => ({ x: p.age, y: p.balance })),
                    borderColor: "#1f6feb",
                    backgroundColor: "rgba(31, 111, 235, 0.08)",
                    borderWidth: 2,
                    tension: 0.25
                },
                {
                    label: "Traditional (after-tax, after RMDs)",
                    data: trad.map(p => ({ x: p.age, y: p.balance })),
                    borderColor: "#b36b00",
                    backgroundColor: "rgba(179, 107, 0, 0.05)",
                    borderWidth: 1.5,
                    borderDash: [4, 4],
                    tension: 0.25
                },
                {
                    label: "Roth (tax-free)",
                    data: roth.map(p => ({ x: p.age, y: p.balance })),
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
                eventShading: {
                    rmdStartAge,
                    stressAge,
                    combinedDepletionAge,
                    lifeExpectancy,
                    bufferScore
                },

                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const datasetLabel = context.dataset.label;
                            const value = context.parsed.y;
                            return `${datasetLabel}: ${formatCurrency(value)}`;
                        },
                        afterBody: function (items) {
                            if (!items.length) return;
                            const age = items[0].parsed.x;
                            const year = engineYears.find(y => y.age === age);
                            if (!year) return;

                            const lines = [];

                            if (year.withdrawal != null) {
                                lines.push(`Withdrawal: ${formatCurrency(year.withdrawal)}`);
                            }
                            if (year.rmdComponent != null && year.rmdComponent > 0) {
                                lines.push(`RMD (net): ${formatCurrency(year.rmdComponent)}`);
                            }
                            if (year.ssIncome != null && year.ssIncome > 0) {
                                lines.push(`Social Security: ${formatCurrency(year.ssIncome)}`);
                            }
                            if (year.taxDrag != null && year.taxDrag > 0) {
                                lines.push(`Tax drag: ${formatCurrency(year.taxDrag)}`);
                            }

                            if (useGlidepath && year.stockWeight != null) {
                                lines.push(
                                    `Allocation: ${Math.round(year.stockWeight * 100)}% stocks / ` +
                                    `${Math.round(year.bondWeight * 100)}% bonds`
                                );
                            }

                            return lines;
                        }
                    }
                },

                annotation: {
                    annotations: {
                        ...(combinedDepletionAge && {
                            depletionLine: {
                                type: "line",
                                xMin: combinedDepletionAge,
                                xMax: combinedDepletionAge,
                                borderColor: "#d32f2f",
                                borderWidth: 1.5,
                                borderDash: [6, 4],
                                label: {
                                    enabled: true,
                                    content: `Depletion age ${combinedDepletionAge}`,
                                    position: "start",
                                    backgroundColor: "#d32f2f",
                                    color: "#fff"
                                }
                            }
                        }),

                        ...(rothSwitchAge && {
                            rothSwitchLine: {
                                type: "line",
                                xMin: rothSwitchAge,
                                xMax: rothSwitchAge,
                                borderColor: "#1a7f37",
                                borderWidth: 1,
                                borderDash: [4, 4],
                                label: {
                                    enabled: true,
                                    content: "Roth withdrawals begin",
                                    position: "center",
                                    backgroundColor: "#1a7f37",
                                    color: "#fff"
                                }
                            }
                        })
                    }
                }
            },

            scales: {
                x: {
                    type: "linear",
                    min: currentAge,
                    max: lifeExpectancy,
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

        plugins: [eventShadingPlugin]
    });
}


/* -------------------------------------------------------
   MAIN RUN HANDLER
------------------------------------------------------- */

async function runProjection() {
    const currentAge = Number($("currentAge").value);
    const retirementAge = Number($("retirementAge").value);
    const lifeExpectancy = Number($("lifeExpectancy").value);
    const spendingNeed = Number($("spendingNeed").value);
    const claimAge = Number($("claimAge").value);
    const ssAnnual = Number($("ssAnnual").value);
    const retireTax = Number($("retireTax").value);
    const expectedReturn = Number($("expectedReturn").value);
    const initialRoth = Number($("initialRoth").value);
    const initialTrad = Number($("initialTrad").value);

    const stockWeight = Number($("stockWeight").value);
    const bondWeight = 1 - stockWeight;

    // Build deterministic engine
    const engineYears = buildDeterministicEngine({
        currentAge,
        retirementAge,
        lifeExpectancy,
        spendingNeed,
        claimAge,
        ssAnnual,
        retireTax,
        expectedReturn,
        initialRoth,
        initialTrad,
        stockWeight,
        bondWeight
    });

    // Depletion ages
    const tradDepletionAge = findTradDepletionAge(engineYears);
    const rothDepletionAge = findRothDepletionAge(engineYears);
    const combinedDepletionAge = findCombinedDepletionAge(engineYears);

    // Longevity buffer
    const yearsUntilDepletion =
        combinedDepletionAge == null || combinedDepletionAge >= 120
            ? null
            : combinedDepletionAge - currentAge;

    const bufferScore = computeLongevityBufferScore(
        yearsUntilDepletion ?? 40
    );

    // Withdrawal report
    const withdrawalReport = buildWithdrawalReport(engineYears, {
        currentAge,
        retirementAge,
        lifeExpectancy,
        spendingNeed
    });

    // Build curves for chart
    const curves = buildCurvesFromEngineYears(engineYears);

    // Insights engine
    const insights = computeProInsights(
        {
            spendingNeedAtRetirement: spendingNeed,
            tradDepletionAge,
            rothDepletionAge,
            combinedDepletionAge,
            bufferScore,
            engineYears,
            withdrawalReport,
            currentAge,
            retirementAge,
            yearsUntilDepletion
        },
        { currentAge, retirementAge }
    );

    // Render summary
    renderSummary(insights);

    // Render chart
    renderGrowthChartV2({
        curves,
        engineYears,
        currentAge,
        lifeExpectancy,
        combinedDepletionAge,
        tradDepletionAge,
        rothDepletionAge,
        bufferScore,
        useGlidepath: true
    });
}
