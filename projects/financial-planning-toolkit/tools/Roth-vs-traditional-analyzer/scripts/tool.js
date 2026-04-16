import { Finance } from "../../../scripts/engine.js";
import { getHistoricalPrices, getMultipleTickers } from "../../../scripts/data.js";
import { calculateCAGR, priceSeriesToDailyReturns } from "../../../scripts/transforms.js";
import { estimateRetirementTaxRate } from "./retirement.js";

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
        trad *= (1 + growthRate);

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
    const years = parseInt($("years").value) || 0;

    const currentTax = (parseFloat($("currentTax").value) || 0) / 100;
    let retireTax = (parseFloat($("retireTax").value) || 0) / 100;

    const growth = (parseFloat($("growth").value) || 0) / 100;
    const ticker = $("ticker").value.trim().toUpperCase();
    const portfolioStr = $("portfolio").value.trim();
    const mcRuns = parseInt($("mcRuns").value) || 0;

    const useAutoTax = $("autoTax") ? $("autoTax").checked : false;

    const currentAge = $("currentAge") ? (parseInt($("currentAge").value) || 60) : 60;
    const retirementAge = $("retirementAge") ? (parseInt($("retirementAge").value) || (currentAge + years)) : (currentAge + years);
    const workStopAge = $("workStopAge") ? (parseInt($("workStopAge").value) || retirementAge) : retirementAge;
    const ssAnnualStatement = $("ssAnnual") ? (parseFloat($("ssAnnual").value) || 0) : 0;
    const claimAge = $("claimAge") ? (parseInt($("claimAge").value) || 67) : 67;
    const filingStatus = $("filingStatus") ? ($("filingStatus").value || "married") : "married";
    const spendingNeed = $("spendingNeed") ? (parseFloat($("spendingNeed").value) || 0) : 0;

    let rate = growth;
    let mode = "synthetic";

    /* ---------------------------------------------------
       OPTIONAL: PORTFOLIO OR SINGLE TICKER → REAL CAGR
    --------------------------------------------------- */
    if (portfolioStr) {
        const { tickers, weights } = parsePortfolio(portfolioStr);
        if (tickers.length) {
            const data = await getMultipleTickers(tickers, "10y", "1d");
            const weightedCagr = await computeWeightedCAGR(data, tickers, weights);
            if (!isNaN(weightedCagr) && weightedCagr > 0) {
                rate = weightedCagr;
                mode = "real-market-portfolio";
            }
        }
    } else if (ticker) {
        const prices = await getHistoricalPrices(ticker, "10y", "1d");
        if (prices.length) {
            rate = calculateCAGR(prices);
            mode = "real-market";
        }
    }

    /* ---------------------------------------------------
       AUTO TAX ESTIMATION (IF ENABLED)
    --------------------------------------------------- */
    let retirementTaxDetails = null;

    if (useAutoTax) {
        const yearsToRetirement = retirementAge - currentAge;
        const yearsFromRetirementToRMD = Math.max(73 - retirementAge, 0);

        retirementTaxDetails = estimateRetirementTaxRate({
            currentTrad,
            yearsToRetirement,
            yearsFromRetirementToRMD,
            growth: rate,
            ssAnnual: ssAnnualStatement,
            claimAge,
            filingStatus,
            spendingNeed
        });

        retireTax = retirementTaxDetails.estimatedRate;
    }

    /* ---------------------------------------------------
       GROW CURRENT BALANCES FORWARD
    --------------------------------------------------- */
    const rothStartingFuture = currentRoth * Math.pow(1 + rate, years);

    const tradStartingFuturePreTax = currentTrad * Math.pow(1 + rate, years);
    const tradStartingFutureAfterTax = tradStartingFuturePreTax * (1 - retireTax);

    /* ---------------------------------------------------
       100% OF CONTRIBUTIONS ARE TREATED AS ROTH CONTRIBUTIONS
       WHEN MODELING THE ROTH SCENARIO.
    --------------------------------------------------- */
    const rothContribution = contribution * (1 - currentTax);

    /* ---------------------------------------------------
       FUTURE CONTRIBUTIONS
    --------------------------------------------------- */
    const rothFuture = Finance.compoundWithContributions({
        initial: 0,
        annualContribution: rothContribution,
        rate,
        years
    });

    const tradFuturePreTax = Finance.compoundWithContributions({
        initial: 0,
        annualContribution: contribution,
        rate,
        years
    });

    const tradFutureAfterTax = tradFuturePreTax * (1 - retireTax);

    /* ---------------------------------------------------
       FINAL TOTALS
    --------------------------------------------------- */
    const rothFinal = rothStartingFuture + rothFuture;
    const tradFinal = tradStartingFutureAfterTax + tradFutureAfterTax;

    /* ---------------------------------------------------
       YEAR-BY-YEAR CURVES FOR CHART
    --------------------------------------------------- */
    const yearly = buildYearlyCurves({
        contribution,
        rothContribution,
        rate,
        years,
        retireTax,
        currentRoth,
        currentTrad
    });

    renderGrowthChart(yearly);
    renderTaxChart({
        contribution,
        rate,
        years,
        currentTax,
        rothFinal
    });

    /* ---------------------------------------------------
       MONTE CARLO (OPTIONAL)
    --------------------------------------------------- */
    let monteCarlo = null;
    if (mcRuns > 0 && (ticker || portfolioStr)) {
        monteCarlo = await runMonteCarlo({
            ticker,
            portfolioStr,
            contribution,
            rothContribution,
            years,
            currentTax,
            retireTax,
            runs: mcRuns,
            currentRoth,
            currentTrad
        });
    }

    /* ---------------------------------------------------
       RESULT OBJECT
    --------------------------------------------------- */
    const taxContext = retirementTaxDetails ? {
        currentTax,               // your current marginal rate
        retireTax,                // auto-tax estimated retirement rate
        filingStatus,
        currentAge,
        retirementAge,
        rmd: retirementTaxDetails.rmd,
        taxableIncome: retirementTaxDetails.taxableIncome,
        grossIncome: retirementTaxDetails.grossIncome
    } : null;


    const result = {
        mode,
        assumedGrowthRate: Finance.round(rate * 100, 2) + "%",
        rothFinal: Finance.round(rothFinal),
        traditionalFinal: Finance.round(tradFinal),
        difference: Finance.round(rothFinal - tradFinal),
        betterOption: rothFinal > tradFinal ? "Roth" : "Traditional",
        breakEvenTaxRate: Finance.round(currentTax * 100, 2) + "%",
        currentRoth,
        currentTrad,
        years,
        monteCarlo,
        retirementTaxDetails,
        taxContext
    };

    renderSummary(result);
    loading.style.display = "none";
    output.textContent = JSON.stringify(result, null, 2);
});

/* -------------------------------------------------------
   PORTFOLIO PARSING & WEIGHTED CAGR
------------------------------------------------------- */

function parsePortfolio(str) {
    const parts = str.split(",").map(s => s.trim()).filter(Boolean);
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

/* -------------------------------------------------------
   YEARLY CURVES FOR CHART
------------------------------------------------------- */

function buildYearlyCurves({ contribution, rothContribution, rate, years, retireTax, currentRoth, currentTrad }) {
    const roth = [];
    const trad = [];

    let rothBal = currentRoth;
    let tradBal = currentTrad;

    for (let year = 1; year <= years; year++) {
        rothBal = rothBal * (1 + rate) + rothContribution;
        tradBal = tradBal * (1 + rate) + contribution;

        roth.push({ year, balance: rothBal });
        trad.push({ year, balance: tradBal * (1 - retireTax) });
    }

    return { roth, trad };
}

/* -------------------------------------------------------
   CHARTS
------------------------------------------------------- */

function renderGrowthChart({ roth, trad }) {
    const ctx = $("growthChart").getContext("2d");

    const labels = roth.map(p => `Year ${p.year}`);
    const rothData = roth.map(p => p.balance);
    const tradData = trad.map(p => p.balance);

    if (growthChart) growthChart.destroy();

    growthChart = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Roth (after-tax)",
                    data: rothData,
                    borderColor: "#2b6cb0",
                    backgroundColor: "rgba(43,108,176,0.1)",
                    tension: 0.2
                },
                {
                    label: "Traditional (after-tax)",
                    data: tradData,
                    borderColor: "#e53e3e",
                    backgroundColor: "rgba(229,62,62,0.1)",
                    tension: 0.2
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
                        callback: v => `$${v.toLocaleString()}`
                    }
                }
            }
        }
    });
}

function renderTaxChart({ contribution, rate, years, currentTax, rothFinal }) {
    const ctx = $("taxChart").getContext("2d");

    const labels = [];
    const tradValues = [];

    for (let t = 0; t <= 50; t += 1) {
        const retireTax = t / 100;
        let tradBal = 0;

        for (let year = 1; year <= years; year++) {
            tradBal = tradBal * (1 + rate) + contribution;
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
                        callback: v => `$${v.toLocaleString()}`
                    }
                }
            }
        }
    });
}

/* -------------------------------------------------------
   MONTE CARLO SIMULATION
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
    currentTrad
}) {
    let dailyReturns = [];

    if (portfolioStr) {
        const { tickers, weights } = parsePortfolio(portfolioStr);
        const data = await getMultipleTickers(tickers, "10y", "1d");

        const series = [];
        for (const t of tickers) {
            const prices = data[t] || [];
            if (!prices.length) continue;
            series.push(priceSeriesToDailyReturns(prices));
        }

        const len = Math.min(...series.map(s => s.length));
        for (let i = 0; i < len; i++) {
            let r = 0;
            for (let j = 0; j < series.length; j++) {
                r += series[j][i].return * weights[j];
            }
            dailyReturns.push(r);
        }
    } else if (ticker) {
        const prices = await getHistoricalPrices(ticker, "10y", "1d");
        dailyReturns = priceSeriesToDailyReturns(prices).map(r => r.return);
    }

    if (!dailyReturns.length) return null;

    const daysPerYear = 252;
    const totalDays = years * daysPerYear;

    const rothResults = [];
    const tradResults = [];

    for (let run = 0; run < runs; run++) {
        let rothBal = currentRoth;
        let tradBal = currentTrad;

        for (let day = 0; day < totalDays; day++) {
            const r = dailyReturns[Math.floor(Math.random() * dailyReturns.length)];

            rothBal *= (1 + r);
            tradBal *= (1 + r);

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
            p10: Finance.round(pct(0.1)),
            p50: Finance.round(pct(0.5)),
            p90: Finance.round(pct(0.9))
        };
    };

    const rothSummary = summarize(rothResults);
    const tradSummary = summarize(tradResults);

    const rothWins = rothResults.filter((v, i) => v > tradResults[i]).length;
    const rothWinProb = (rothWins / runs) * 100;

    return {
        runs,
        roth: rothSummary,
        traditional: tradSummary,
        rothWinProbability: Finance.round(rothWinProb, 1) + "%"
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
        return [{
            type: "neutral",
            text: "No guidance available for this scenario."
        }];
    }

    const {
        rmd,
        ssAtClaimAge,
        estimatedRate,
        otherWithdrawals
    } = retirementTaxDetails;

    const currentTaxRate = parseFloat(breakEvenTaxRate);

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

/* -------------------------------------------------------
   PRO INSIGHTS (COMPUTATION)
------------------------------------------------------- */

function computeProInsights(result) {
    const {
        currentRoth,
        currentTrad,
        retirementTaxDetails,
        taxContext
    } = result;

    const total = currentRoth + currentTrad || 1;
    const rothShare = currentRoth / total;

    // -------------------------------------------------------
    // TAX DIVERSIFICATION SCORE
    // -------------------------------------------------------
    const diversificationScore = Math.round(
        100 * (1 - Math.abs(rothShare - 0.5) / 0.5)
    );

    // -------------------------------------------------------
    // DEFAULTS FOR ADVANCED METRICS
    // -------------------------------------------------------
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


    // -------------------------------------------------------
    // ADVANCED METRICS ONLY IF TAX DETAILS ARE AVAILABLE
    // -------------------------------------------------------
    if (retirementTaxDetails && taxContext) {
        const { rmd, tradAt73, estimatedRate } = retirementTaxDetails;
        const {
            filingStatus,
            taxableIncome,
            grossIncome,
            currentTax,
            retireTax,
            retirementAge
        } = taxContext;

        // -------------------------------------------------------
        // RMD PRESSURE SCORE
        // -------------------------------------------------------
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

        // -------------------------------------------------------
        // BRACKET FILL OPPORTUNITY
        // -------------------------------------------------------
        const { brackets } = getBracketThresholds({ filingStatus });

        const taxable = Math.max(taxableIncome, 0);
        const currentBracket = brackets.find(b => taxable <= b.top) || brackets[brackets.length - 1];
        const nextBracketIndex = brackets.indexOf(currentBracket) + 1;
        const nextBracket = brackets[nextBracketIndex];

        if (nextBracket) {
            const space = Math.max(nextBracket.top - taxable, 0);
            bracketFillAmount = Finance.round(space);
            bracketFillRate = currentBracket.rate;
        }

        // -------------------------------------------------------
        // BRACKET INSIGHTS (CURRENT + NEXT BRACKET)
        // -------------------------------------------------------
       
        if (currentBracket) {
            currentBracketRate = currentBracket.rate;

            // Room left in the CURRENT bracket
            currentBracketFill = Math.max(currentBracket.top - taxable, 0);

            // Room left until the NEXT bracket top
            if (nextBracket) {
                nextBracketFill = Math.max(nextBracket.top - taxable, 0);
                nextBracketRate = nextBracket.rate;

                // Tax jump (e.g., 22% → 24%)
                taxJump = nextBracketRate - currentBracketRate;
            }
        }


        // -------------------------------------------------------
        // IRMAA RISK SCORE
        // -------------------------------------------------------
        const irmaaThresholds = getIrmaaThresholds({ filingStatus });
        const magi = grossIncome;

        let band = 0;
        for (let i = 0; i < irmaaThresholds.length; i++) {
            if (magi > irmaaThresholds[i]) band = i + 1;
        }

        irmaaRiskScore = Math.min(100, band * 20);

        // -------------------------------------------------------
        // SAFE CONVERSION RANGE (BRACKET + IRMAA AWARE)
        // -------------------------------------------------------
        let irmaaHeadroom = null;
        const nextIrmaa = irmaaThresholds.find(t => magi < t);
        if (nextIrmaa) {
            irmaaHeadroom = Math.max(nextIrmaa - magi, 0);
        }

        if (bracketFillAmount !== null) {
            const maxByBracket = bracketFillAmount;
            const maxByIrmaa = irmaaHeadroom !== null ? irmaaHeadroom : maxByBracket;
            const safeMax = Math.max(0, Math.min(maxByBracket, maxByIrmaa));

            safeConversionMin = 0;
            safeConversionMax = Finance.round(safeMax);
        }

        // -------------------------------------------------------
        // SIMULATION: CONVERT SAFE AMOUNT EVERY YEAR UNTIL 73
        // -------------------------------------------------------
        if (safeConversionMax !== null && safeConversionMax > 0) {
            const startAge = retirementAge;
            const endAge = 73;
            const annualConversion = safeConversionMax;

            const growthRate =
                parseFloat(result.assumedGrowthRate) / 100 || 0.07;

            const baseTaxRate = currentTax;

            const sim = simulateRothConversions({
                currentTrad,
                startAge,
                endAge,
                annualConversion,
                growthRate,
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

        // -------------------------------------------------------
        // MAXIMUM ALLOWABLE CONVERSION (BEFORE CROSSING BRACKET/IRMAA)
        // -------------------------------------------------------
        if (bracketFillAmount !== null) {
            const maxByBracket = bracketFillAmount;
            const maxByIrmaa = irmaaHeadroom !== null ? irmaaHeadroom : maxByBracket;
            maxConversion = Math.max(maxByBracket, maxByIrmaa);
        }

        // -------------------------------------------------------
        // TAX TRAJECTORY
        // -------------------------------------------------------
        taxTrajectory = {
            currentRate: currentTax,
            retireRate: retireTax,
            rmdRate: retireTax
        };
    }

    // -------------------------------------------------------
    // RETURN ALL INSIGHTS
    // -------------------------------------------------------
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
        taxJump
    };
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
        maxConversion
    } = computeProInsights(result);

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
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Bracket Fill Opportunity</div>
                <div>You can convert about $${bracketFillAmount.toLocaleString()} at roughly ${(bracketFillRate * 100).toFixed(0)}% before reaching the next bracket.</div>
            </div>

            <!-- Bracket Insight Block -->
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Tax Bracket Insights</div>

                <div>
                    <strong>Room in current bracket (${(currentBracketRate * 100).toFixed(0)}%):</strong>
                    $${currentBracketFill.toLocaleString()}
                </div>

                <div>
                    <strong>Room until next bracket (${(nextBracketRate * 100).toFixed(0)}%):</strong>
                    $${nextBracketFill.toLocaleString()}
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
                <div>You can likely convert up to $${safeConversionMax.toLocaleString()} this year without leaving your current bracket or crossing the next IRMAA tier.</div>
            </div>
        `;
    }

    if (conversionImpact) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Safe Conversion Impact</div>

                <div>
                    Converting your <strong>safe maximum</strong> of 
                    $${conversionImpact.annualConversion.toLocaleString()} per year until age 73 
                    reduces your RMD from 
                    $${conversionImpact.rmdBefore.toLocaleString()} 
                    to 
                    $${conversionImpact.rmdAfter.toLocaleString()} 
                    (a reduction of $${conversionImpact.rmdReduction.toLocaleString()}).
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

    html += `</div>`;
    el.innerHTML = html;

    // -------------------------------------------------------
    // SET SLIDER MAX TO TRUE MAX CONVERSION
    // -------------------------------------------------------
    const slider = document.getElementById("conversionSlider");
    if (slider && maxConversion !== null) {
        slider.max = maxConversion;
    }
}



/* -------------------------------------------------------
   SUMMARY RENDERER
------------------------------------------------------- */

function renderSummary(result) {
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
        conversionImpact
    } = result;

    const diffLabel = difference >= 0 ? "Roth ahead by" : "Traditional ahead by";

    let html = `
        <h3>Comparison</h3>
        <table class="summary-table">
            <tr><th>Metric</th><th>Roth</th><th>Traditional</th></tr>
            <tr><td>Starting Balance</td><td>$${currentRoth.toLocaleString()}</td><td>$${currentTrad.toLocaleString()}</td></tr>
            <tr><td>Final After-Tax Value</td><td>$${rothFinal.toLocaleString()}</td><td>$${traditionalFinal.toLocaleString()}</td></tr>
            <tr><td>Better Option</td><td colspan="2">${betterOption}</td></tr>
            <tr><td>${diffLabel}</td><td colspan="2">$${Math.abs(difference).toLocaleString()}</td></tr>
            <tr><td>Assumed Growth Rate</td><td colspan="2">${assumedGrowthRate}</td></tr>
            <tr><td>Break-Even Tax Rate</td><td colspan="2">${breakEvenTaxRate}</td></tr>
            <tr><td>Mode</td><td colspan="2">${mode}</td></tr>
        </table>
    `;

    if (retirementTaxDetails) {
        const t = retirementTaxDetails;
        html += `
            <h3>Retirement Tax Estimate</h3>
            <table class="summary-table">
                <tr><td>Estimated RMD at 73</td><td>$${t.rmd.toLocaleString()}</td></tr>
                <tr><td>Estimated Social Security (at claim age)</td><td>$${t.ssAtClaimAge.toLocaleString()}</td></tr>
                <tr><td>Estimated Taxable Social Security</td><td>$${t.taxableSS.toLocaleString()}</td></tr>
                <tr><td>Estimated Taxable Income</td><td>$${t.taxableIncome.toLocaleString()}</td></tr>
                <tr><td>Estimated Retirement Tax Rate</td><td>${(t.estimatedRate * 100).toFixed(1)}%</td></tr>
            </table>
        `;
    }

    if (monteCarlo) {
        html += `
            <h3>Monte Carlo Summary (${monteCarlo.runs} runs)</h3>
            <table class="summary-table">
                <tr><th></th><th>10th %ile</th><th>Median</th><th>90th %ile</th></tr>
                <tr><td>Roth</td><td>$${monteCarlo.roth.p10.toLocaleString()}</td><td>$${monteCarlo.roth.p50.toLocaleString()}</td><td>$${monteCarlo.roth.p90.toLocaleString()}</td></tr>
                <tr><td>Traditional</td><td>$${monteCarlo.traditional.p10.toLocaleString()}</td><td>$${monteCarlo.traditional.p50.toLocaleString()}</td><td>$${monteCarlo.traditional.p90.toLocaleString()}</td></tr>
                <tr><td>Roth Win Probability</td><td colspan="3">${monteCarlo.rothWinProbability}</td></tr>
            </table>
        `;
    }

    el.innerHTML = html;

    /* -------------------------------------------------------
       GUIDANCE RENDERING
    ------------------------------------------------------- */

    const guidanceItems = generateGuidance(result);

    let guidanceHtml = "";

    for (const item of guidanceItems) {
        guidanceHtml += `
            <div class="guidance-item ${item.type}">
                ${item.type === "warning" ? "⚠️" : item.type === "info" ? "💡" : "⏳"} 
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

    /* -------------------------------------------------------
   PRO INSIGHTS RENDER CALL
------------------------------------------------------- */

    renderProInsights(result);

    // -------------------------------------------------------
    // CUSTOM CONVERSION SLIDER LISTENER
    // -------------------------------------------------------
    const slider = document.getElementById("conversionSlider");
    const sliderValue = document.getElementById("conversionSliderValue");
    const warningBox = document.getElementById("conversion-warning");

    if (slider) {
        slider.addEventListener("input", () => {
            const annualConversion = parseInt(slider.value) || 0;

            // Update label
            sliderValue.textContent = `$${annualConversion.toLocaleString()} per year`;

            // Pull needed values from result
            const { currentTrad } = result;
            const { filingStatus, currentTax, retirementAge, rmd } = result.taxContext;

            // Growth rate (corrected)
            const growthRate =
                parseFloat(result.assumedGrowthRate) / 100 || 0.07;

            // Run simulation
            const sim = simulateRothConversions({
                currentTrad,
                startAge: retirementAge,
                endAge: 73,
                annualConversion,
                growthRate,
                filingStatus,
                baseTaxRate: currentTax
            });

            // Render simulation impact
            renderConversionSimulation({
                annualConversion,
                startAge: retirementAge,
                rmdBefore: rmd,
                rmdAfter: Finance.round(sim.rmdAt73),
                rmdReduction: Finance.round(rmd - sim.rmdAt73)
            });

            // Warning logic
            if (currentTax < result.taxContext.retireTax && annualConversion > 0) {
                warningBox.style.display = "block";
            } else {
                warningBox.style.display = "none";
            }
        });
    }
}

