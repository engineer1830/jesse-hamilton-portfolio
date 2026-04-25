/* ---------------------------------------------------
   GLOBAL FUNCTIONS
--------------------------------------------------- */

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
    return Math.max(1, 16 - (age - 85) * 0.7);

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

/* ---------------------------------------------------
   CHART SHADING & GROWTH HELPERS
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

        // Longevity buffer shading (beyond combined depletion)
        if (combinedDepletionAge != null && bufferScore != null && bufferScore >= 80) {
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

/* Depletion helpers */

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

// Curves builder for chart
function buildCurvesFromEngineYears(engineYears) {
    return {
        labels: engineYears.map(y => y.age),
        roth: engineYears.map(y => ({ age: y.age, balance: y.rothBalance })),
        trad: engineYears.map(y => ({ age: y.age, balance: y.tradBalance })),
        combined: engineYears.map(y => ({ age: y.age, balance: y.combinedBalance })),
        depletionAge: engineYears.find(y => y.combinedBalance <= 0)?.age ?? null
    };
}


function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/* -------------------------------------------------------
   WITHDRAWAL REPORT (DERIVED FROM engineYears)
------------------------------------------------------- */

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

// below this is beginning for paste of step 2

/* -------------------------------------------------------
   GROWTH CHART RENDERER (V2 - advisor grade)
------------------------------------------------------- */

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
                // ⭐ Event-driven shading (RMD, stress age, longevity buffer)
                eventShading: {
                    rmdStartAge,
                    stressAge,
                    combinedDepletionAge,
                    lifeExpectancy,
                    bufferScore
                },

                // ⭐ Enhanced tooltips
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

                // ⭐ Annotation markers (depletion + Roth switch)
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
// End of paste for step 2 . . . content between here and the main handler was from the final clean up for V2

const $ = id => document.getElementById(id);

let growthChart = null;
let taxChart = null;

/* --------------------------------------------------------
  INSIGHTS HELPERS
-------------------------------------------------------*/


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
   DETERMINISTIC ENGINE (Option A — single source of truth)
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

        // Apply withdrawals (Traditional first, then Roth)
        const before = { roth, trad };
        const after = applyWithdrawals({
            age,
            roth,
            trad,
            spendingNeed: spending,
            ssIncome,
            retireTax
        });

        const withdrawal = (before.trad - after.trad) + (before.roth - after.roth);

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
            taxDrag: 0,
            stockWeight,
            bondWeight
        });
    }

    return engineYears;
}

/* -------------------------------------------------------
   CLASSIFY SPENDING TIER
------------------------------------------------------- */

function classifySpendingTier({
    requiredWithdrawalRate,
    yearsUntilDepletion,
    catastrophic,
    bufferScore
}) {
    // If catastrophic, always unsustainable
    if (catastrophic) return "unsustainable";

    // If no depletion within horizon (120+) and buffer is strong, treat as supported
    if (yearsUntilDepletion == null && bufferScore >= 80) {
        if (requiredWithdrawalRate <= 0.035) return "conservative";
        if (requiredWithdrawalRate <= 0.045) return "supported";
        if (requiredWithdrawalRate <= 0.055) return "elevated-supported";
        if (requiredWithdrawalRate <= 0.065) return "aggressive-but-supported";
        return "unsustainable";
    }

    // If we *do* have a depletion age, use both rate and yearsUntilDepletion
    const yrs = yearsUntilDepletion ?? 0;

    if (requiredWithdrawalRate <= 0.035 && yrs >= 40) return "conservative";
    if (requiredWithdrawalRate <= 0.045 && yrs >= 35) return "supported";
    if (requiredWithdrawalRate <= 0.055 && yrs >= 30) return "elevated-supported";
    if (requiredWithdrawalRate <= 0.065 && yrs >= 25) return "aggressive-but-supported";

    return "unsustainable";
}

/* -------------------------------------------------------
   ADVISOR‑GRADE INSIGHTS ENGINE (Corrected Version)
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
        // If depletion age is missing or at/above 120, treat as "no depletion"
        if (
            combinedDepletionAge == null ||
            combinedDepletionAge >= 120 ||
            currentAge == null
        ) {
            yearsUntilDepletion = null;
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

    // Longevity penalty (only if we actually have a depletion age)
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
        "classic-safe": "Classic Safe Range",
        "elevated-supported": "Elevated but Supported",
        "aggressive-but-supported": "Aggressive but Supported",
        "unsustainable": "Unsustainable"
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
        <div class="summary-zone" style="border-left: 6px solid ${zoneColor}; padding-left: 12px;">
            <h2 style="margin: 0; color: ${zoneColor}; text-transform: capitalize;">
                ${zone} zone
            </h2>
            <p style="margin: 4px 0 0 0; font-size: 0.95rem;">
                Readiness Score: <strong>${readiness}/100</strong>
            </p>
        </div>

        <div class="summary-section">
            <h3>Spending Outlook</h3>
            <p><strong>${tierLabel}</strong></p>
            <p>Required Withdrawal Rate: <strong>${(requiredWithdrawalRate * 100).toFixed(1)}%</strong></p>
        </div>

        <div class="summary-section">
            <h3>Longevity Outlook</h3>
            <p><strong>${bufferLabel}</strong></p>
            <p>Years Until Depletion: <strong>${yearsUntilDepletion}</strong></p>
            <p>Traditional Depletion Age: <strong>${depletionDiagnostics.tradDepletionAge ?? "N/A"}</strong></p>
            <p>Roth Depletion Age: <strong>${depletionDiagnostics.rothDepletionAge ?? "N/A"}</strong></p>
            <p>Combined Depletion Age: <strong>${depletionDiagnostics.combinedDepletionAge ?? "N/A"}</strong></p>
        </div>

        <div class="summary-section">
            <h3>Why This Matters</h3>
            <ul>
                ${whyMessages.map(msg => `<li>${msg}</li>`).join("")}
            </ul>
        </div>

        <div class="summary-section">
            <h3>Recommended Actions</h3>
            <ul>
                ${recommendations.map(r => `<li>${r}</li>`).join("")}
            </ul>
        </div>
    `;
}

/* -------------------------------------------------------
   MAIN RUN HANDLER (CLEAN V2 VERSION)
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
    const currentRoth = parseFloat($("currentRoth").value) || 0;
    const currentTrad = parseFloat($("currentTrad").value) || 0;

    const contribution = parseFloat($("contribution").value) || 0;

    const currentTax = (parseFloat($("currentTax").value) || 0) / 100;
    let retireTax = (parseFloat($("retireTax").value) || 0) / 100;

    const growth = (parseFloat($("growth").value) || 0) / 100;
    const lifeExpectancy = 120;

    let portfolioStr = $("portfolio").value;
    portfolioStr = portfolioStr.replace(/[\s\u200B-\u200D\uFEFF]/g, "");

    const mcRuns = parseInt($("mcRuns").value) || 0;
    const useAutoTax = $("autoTax") ? $("autoTax").checked : false;

    const currentAge = parseInt($("currentAge").value) || 60;
    const retirementAge = parseInt($("retirementAge").value) || currentAge + 25;

    const years = retirementAge - currentAge;
    if (years <= 0) {
        alert("Retirement age must be greater than current age.");
        return;
    }

    const workStopAge = parseInt($("workStopAge").value) || retirementAge;
    const ssAnnualStatement = parseFloat($("ssAnnual").value) || 0;
    const claimAge = parseInt($("claimAge").value) || 67;
    const filingStatus = $("filingStatus").value || "married";
    const spendingNeed = parseFloat($("spendingNeed").value) || 0;

    const useGlidepath = $("useGlidepath").checked;

    let mode = "synthetic";
    let expectedReturn;
    let stockVol;

    /* ---------------------------------------------------
       INPUT GUARDRAILS
    --------------------------------------------------- */

    const ticker = $("ticker").value.trim().toUpperCase();

    if (ticker !== "" && portfolioStr !== "") {
        alert("Please choose either a single ticker OR a portfolio, not both.");
        return;
    }

    if (portfolioStr !== "" && !/[A-Za-z]/.test(portfolioStr)) {
        alert("Portfolio must contain tickers with weights, like VTI:60, BND:40.");
        return;
    }

    if (portfolioStr !== "" && portfolioStr.includes(",") && !portfolioStr.includes(":")) {
        alert("Each portfolio ticker needs a weight, like VTI:60.");
        return;
    }

    if (portfolioStr !== "") {
        const { tickers } = parsePortfolio(portfolioStr);
        if (tickers.length === 1) {
            alert("It looks like you entered a single ticker in the portfolio box. Use the Ticker field instead.");
            return;
        }
    }

    if (ticker !== "" && !/^[A-Za-z]{1,5}$/.test(ticker)) {
        alert("That doesn’t look like a valid ticker symbol.");
        return;
    }

    if (!useGlidepath && ticker === "" && portfolioStr === "") {
        alert("Please enter a ticker, a portfolio, or enable Glidepath.");
        return;
    }

    /* ---------------------------------------------------
       GLIDEPATH ENGINE (if enabled)
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

            const stockReturn = stockPrices.length ? calculateCAGR(stockPrices) : growth;
            const bondReturn = bondPrices.length ? calculateCAGR(bondPrices) : growth;

            const stockVolDaily = stockPrices.length
                ? Finance.stddev(stockPrices.slice(1).map((p, i) => {
                    const prev = stockPrices[i].close;
                    return (p.close - prev) / prev;
                }))
                : 0.15 / Math.sqrt(252);

            const bondVolDaily = bondPrices.length
                ? Finance.stddev(bondPrices.slice(1).map((p, i) => {
                    const prev = bondPrices[i].close;
                    return (p.close - prev) / prev;
                }))
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
                    stockWeight = 1.0;
                    bondWeight = 0.0;
                } else {
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
       REAL-MARKET RETURN (if glidepath is OFF)
    --------------------------------------------------- */

    if (!useGlidepath) {
        if (portfolioStr !== "") {
            const { tickers, weights } = parsePortfolio(portfolioStr);

            if (tickers.length) {
                try {
                    const data = await getMultipleTickers(tickers, "10y", "1d");
                    const weightedCagr = await computeWeightedCAGR(data, tickers, weights);
                    const weightedVol = await computeWeightedVolatility(data, tickers, weights);

                    if (!isNaN(weightedCagr) && weightedCagr > 0) {
                        expectedReturn = weightedCagr;
                        stockVol = weightedVol;
                        mode = "real-market-portfolio";
                    }
                } catch (err) {
                    console.warn("Portfolio real-market fetch failed:", err);
                }
            }
        } else if (ticker !== "") {
            try {
                const prices = await getHistoricalPrices(ticker, "10y", "1d");
                if (prices.length) {
                    expectedReturn = calculateCAGR(prices);
                    mode = "real-market";
                }
            } catch (err) {
                console.warn("Single-ticker real-market fetch failed:", err);
            }
        }
    }

    /* ---------------------------------------------------
       LIVE RETURN FALLBACK
    --------------------------------------------------- */

    if (!useGlidepath && expectedReturn === undefined) {
        try {
            const prices = await getHistoricalPrices(ticker || "VTI", "10y", "1d");
            const stats = computeReturnStats(prices);
            expectedReturn = stats.annualReturn;
        } catch (err) {
            console.warn("Live return fallback failed:", err);
            expectedReturn = growth;
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
       DETERMINISTIC WITHDRAWAL ENGINE
    --------------------------------------------------- */

    const engineYears = buildDeterministicEngine({
        currentAge,
        retirementAge,
        lifeExpectancy,
        spendingNeed,
        claimAge,
        ssAnnual: ssAnnualStatement,
        retireTax,
        expectedReturn,
        initialRoth: currentRoth,
        initialTrad: currentTrad,
        stockWeight: null,
        bondWeight: null
    });

    const tradDepletionAge = findTradDepletionAge(engineYears);
    const rothDepletionAge = findRothDepletionAge(engineYears);
    const combinedDepletionAge = findCombinedDepletionAge(engineYears);

    const yearsUntilDepletion = combinedDepletionAge - currentAge;
    const bufferScore = computeLongevityBufferScore(yearsUntilDepletion);

    const withdrawalReport = buildWithdrawalReport(engineYears, {
        currentAge,
        retirementAge,
        lifeExpectancy,
        spendingNeed
    });

    // 5. Build curves for chart
    const curves = buildCurvesFromEngineYears(engineYears);

    // 6. Render V2 chart
    renderGrowthChartV2({
        curves,
        engineYears,
        currentAge,
        lifeExpectancy,
        combinedDepletionAge,
        tradDepletionAge,
        rothDepletionAge,
        bufferScore,
        useGlidepath
    });


    /* ---------------------------------------------------
       MONTE CARLO (optional)
    --------------------------------------------------- */

    let monteCarlo = null;
    const mcTicker = $("ticker").value.trim().toUpperCase();

    if (mcRuns > 0 && (mcTicker || portfolioStr)) {
        monteCarlo = await runMonteCarlo({
            ticker: mcTicker,
            portfolioStr,
            contribution,
            rothContribution: contribution * (1 - currentTax),
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

    const result = {
        mode,
        expectedReturn,
        stockVol,
        currentRoth,
        currentTrad,
        years,
        retirementTaxDetails,
        spendingNeedAtRetirement: spendingNeed,
        tradDepletionAge,
        rothDepletionAge,
        combinedDepletionAge,
        bufferScore,
        engineYears,
        withdrawalReport,
        monteCarlo
    };

    /* ---------------------------------------------------
   INSIGHTS + SUMMARY
    --------------------------------------------------- */

    const insights = computeProInsights(result, {
        currentAge: formValues.currentAge,      // or whatever your source is
        retirementAge: formValues.retirementAge
    });
    
    const full = {
        ...result,
        ...insights
    };

    renderSummary(full);

    loading.style.display = "none";
    output.textContent = JSON.stringify(full, null, 2);
});   // ← CLOSES runBtn click handler

/* --------------------------------------------------------
   INSIGHTS HELPERS
--------------------------------------------------------*/

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

/* --------------------------------------------------------
   RMD DIVISOR (CLAMPED TO PREVENT NEGATIVE RMDs)
--------------------------------------------------------*/

function getRmdDivisor(age) {
    if (age < 73) return Infinity;
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

    // Prevent negative divisors → clamp to minimum of 1
    return Math.max(1, 16 - (age - 85) * 0.7);
}

/* --------------------------------------------------------
   COMPUTE PRO INSIGHTS (FINAL VERSION)
--------------------------------------------------------*/

function computeProInsights(result) {
    const {
        spendingNeedAtRetirement,
        tradDepletionAge,
        rothDepletionAge,
        combinedDepletionAge,
        bufferScore,
        currentAge,
        retirementAge,
        engineYears,
        withdrawalReport
    } = result;

    /* 1. Required Withdrawal Rate */
    const requiredWithdrawalRate =
        withdrawalReport?.requiredWithdrawalRate ?? 0;

    /* 2. Years Until Depletion */
    let yearsUntilDepletion = null;

    if (
        combinedDepletionAge != null &&
        combinedDepletionAge < 120 &&
        currentAge != null
    ) {
        yearsUntilDepletion = combinedDepletionAge - currentAge;
    }

    /* 3. Catastrophic */
    const catastrophic =
        combinedDepletionAge != null &&
        combinedDepletionAge < 120 &&
        combinedDepletionAge < retirementAge + 10;

    /* 4. Spending Tier */
    const spendingTier = classifySpendingTier({
        requiredWithdrawalRate,
        yearsUntilDepletion,
        catastrophic,
        bufferScore
    });

    /* 5. Zone */
    let zone = "green";
    if (spendingTier === "elevated-supported") zone = "yellow";
    if (spendingTier === "aggressive-but-supported") zone = "yellow";
    if (spendingTier === "unsustainable") zone = "red";
    if (catastrophic) zone = "red";

    /* 6. Buffer Tier */
    let bufferTier = "strong";
    if (bufferScore < 80) bufferTier = "supported";
    if (bufferScore < 60) bufferTier = "warning";
    if (bufferScore < 40) bufferTier = "danger";

    /* 7. Readiness Score */
    let readiness = 100;

    if (requiredWithdrawalRate > 0.04) readiness -= 15;
    if (requiredWithdrawalRate > 0.05) readiness -= 25;
    if (requiredWithdrawalRate > 0.06) readiness -= 35;

    if (yearsUntilDepletion != null) {
        if (yearsUntilDepletion < 35) readiness -= 10;
        if (yearsUntilDepletion < 25) readiness -= 20;
        if (yearsUntilDepletion < 15) readiness -= 30;
    }

    if (catastrophic) readiness -= 40;

    readiness = Math.max(0, Math.min(100, readiness));

    /* 8. Why Messages */
    const whyMessages = getWhyMessages(zone);

    /* 9. Depletion Diagnostics */
    const depletionDiagnostics = {
        tradDepletionAge,
        rothDepletionAge,
        combinedDepletionAge,
        yearsUntilDepletion,
        catastrophic
    };

    /* 10. Recommendations */
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

/* --------------------------------------------------------
   SUMMARY RENDERER (FINAL VERSION)
--------------------------------------------------------*/

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

    let zoneColor = "#2e7d32";
    if (zone === "yellow") zoneColor = "#f9a825";
    if (zone === "red") zoneColor = "#c62828";

    const tierLabels = {
        "classic-safe": "Classic Safe Range",
        "supported": "Supported",
        "elevated-supported": "Elevated but Supported",
        "aggressive-but-supported": "Aggressive but Supported",
        "unsustainable": "Unsustainable"
    };

    const bufferLabels = {
        strong: "Strong Longevity Buffer",
        supported: "Supported Longevity Buffer",
        warning: "Warning Zone",
        danger: "Danger Zone"
    };

    summary.innerHTML = `
        <div class="summary-zone" style="border-left: 6px solid ${zoneColor}; padding-left: 12px;">
            <h2 style="margin: 0; color: ${zoneColor}; text-transform: capitalize;">
                ${zone} zone
            </h2>
            <p style="margin: 4px 0 0 0; font-size: 0.95rem;">
                Readiness Score: <strong>${readiness}/100</strong>
            </p>
        </div>

        <div class="summary-section">
            <h3>Spending Outlook</h3>
            <p><strong>${tierLabels[spendingTier] || spendingTier}</strong></p>
            <p>Required Withdrawal Rate: <strong>${(requiredWithdrawalRate * 100).toFixed(1)}%</strong></p>
        </div>

        <div class="summary-section">
            <h3>Longevity Outlook</h3>
            <p><strong>${bufferLabels[bufferTier]}</strong></p>
            <p>Years Until Depletion: <strong>${yearsUntilDepletion ?? "No depletion"}</strong></p>
        </div>

        <div class="summary-section">
            <h3>Why This Matters</h3>
            <ul>${whyMessages.map(m => `<li>${m}</li>`).join("")}</ul>
        </div>

        <div class="summary-section">
            <h3>Recommended Actions</h3>
            <ul>${recommendations.map(r => `<li>${r}</li>`).join("")}</ul>
        </div>
    `;
}
