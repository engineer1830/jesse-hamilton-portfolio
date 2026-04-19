/* ---------------------------------------------------
CHART SHADING SET UP
--------------------------------------------------- */

const phaseShadingPlugin = {
    id: "phaseShading",
    beforeDraw(chart, args, options) {
        const { ctx, chartArea: { left, right, top, bottom }, scales: { x } } = chart;

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
    if (value === null || value === undefined || isNaN(value)) return "$0";
    return "$" + Number(value).toLocaleString();
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
  

import { Finance } from "../../../scripts/engine.js";
import { getHistoricalPrices, getMultipleTickers } from "../../../scripts/data.js";
import { calculateCAGR, priceSeriesToDailyReturns } from "../../../scripts/transforms.js";
import { estimateRetirementTaxRate } from "./retirement.js";


// Simple IRS Uniform Lifetime Table approximation
function getRmdDivisor(age) {
    if (age < 73) return Infinity;      // no RMD yet
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
    const url = `/api/yahoo?ticker=${ticker}&range=max&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch price data");
    return await response.json();
}

function computeReturnStats(prices) {
    prices = limitToLastNYears(prices, 10);   // <-- ADD THIS LINE

    if (!prices || prices.length < 2) {
        return { mean: 0, vol: 0 };
    }
    
    const dailyReturns = [];

    for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1].close;
        const curr = prices[i].close;
        dailyReturns.push((curr - prev) / prev);
    }

    const avgDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;

    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDaily, 2), 0) /
        (dailyReturns.length - 1);
    const dailyVol = Math.sqrt(variance);

    const annualReturn = Math.pow(1 + avgDaily, 252) - 1;
    const annualVol = dailyVol * Math.sqrt(252);

    return { annualReturn, annualVol };
}

document.getElementById("overrideVolToggle").addEventListener("change", (e) => {
    document.getElementById("customVolInputs").style.display =
        e.target.checked ? "block" : "none";
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
    // years will be derived from ages

    const currentTax = (parseFloat($("currentTax").value) || 0) / 100;
    let retireTax = (parseFloat($("retireTax").value) || 0) / 100;

    const growth = (parseFloat($("growth").value) || 0) / 100;
    const lifeExpectancy = 85;


    // Sanitize portfolio string
    let portfolioStr = $("portfolio").value;
    portfolioStr = portfolioStr.replace(/[\s\u200B-\u200D\uFEFF]/g, "");

    const mcRuns = parseInt($("mcRuns").value) || 0;
    const useAutoTax = $("autoTax") ? $("autoTax").checked : false;

    const currentAge = $("currentAge") ? (parseInt($("currentAge").value) || 60) : 60;
    const retirementAge = $("retirementAge")
        ? (parseInt($("retirementAge").value) || currentAge + 25)  // or any reasonable default span
        : (currentAge + 25);

    const years = retirementAge - currentAge;
    if (years <= 0) {
        alert("Retirement age must be greater than current age.");
        return;
    }
    
    const workStopAge = $("workStopAge") ? (parseInt($("workStopAge").value) || retirementAge) : retirementAge;
    const ssAnnualStatement = $("ssAnnual") ? (parseFloat($("ssAnnual").value) || 0) : 0;
    const claimAge = $("claimAge") ? (parseInt($("claimAge").value) || 67) : 67;
    const filingStatus = $("filingStatus") ? ($("filingStatus").value || "married") : "married";
    const spendingNeed = $("spendingNeed") ? (parseFloat($("spendingNeed").value) || 0) : 0;

    const useGlidepath = $("useGlidepath") ? $("useGlidepath").checked : false;


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
            alert("It looks like you entered a single ticker in the portfolio box. Use the Ticker field instead.");
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
            const data = await getMultipleTickers(tickers, "max", "1d");

            const stockPrices = data[glidepathStockTicker] || [];
            const bondPrices = data[glidepathBondTicker] || [];

            const stockReturn = stockPrices.length ? calculateCAGR(stockPrices) : growth;
            const bondReturn = bondPrices.length ? calculateCAGR(bondPrices) : growth;

            const stockVolDaily = stockPrices.length
                ? Finance.stddev(stockPrices.slice(1).map((p, i) =>
                    (p.close - stockPrices[i].close) / stockPrices[i].close))
                : 0.15 / Math.sqrt(252);

            const bondVolDaily = bondPrices.length
                ? Finance.stddev(bondPrices.slice(1).map((p, i) =>
                    (p.close - bondPrices[i].close) / bondPrices[i].close))
                : 0.07 / Math.sqrt(252);

            const stockVolAnnual = stockVolDaily * Math.sqrt(252);
            const bondVolAnnual = bondVolDaily * Math.sqrt(252);

            // EXTENDED RANGE
            const totalYears = lifeExpectancy - currentAge;

            yearlyExpectedReturns = [];
            yearlyVols = [];

            for (let i = 0; i < totalYears; i++) {
                const age = currentAge + i;
                const { stockWeight, bondWeight } = getGlidepathAllocation(age, retirementAge);

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
    REAL-MARKET RETURN (PORTFOLIO OR SINGLE TICKER)
    (Only runs when glidepath is OFF)
 --------------------------------------------------- */

    if (!useGlidepath) {

        if (portfolioStr !== "") {
            // Portfolio mode
            const { tickers, weights } = parsePortfolio(portfolioStr);

            if (tickers.length) {
                try {
                    const data = await getMultipleTickers(tickers, "max", "1d");
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

        } else {
            // Single ticker mode
            const ticker = $("ticker").value.trim().toUpperCase();
            console.log("REAL-MARKET CHECK — ticker (fresh):", JSON.stringify(ticker));

            if (ticker !== "") {
                try {
                    const prices = await getHistoricalPrices(ticker, "max", "1d");
                    if (prices.length) {
                        expectedReturn = calculateCAGR(prices);
                        mode = "real-market";
                    }
                } catch (err) {
                    console.warn("Single-ticker real-market fetch failed:", err);
                }
            }
        }

    } // END: !useGlidepath guard
 

    /* ---------------------------------------------------
       LIVE RETURN FALLBACK (ONLY IF REAL-MARKET FAILED)
    --------------------------------------------------- */
    if (!useGlidepath && expectedReturn === undefined) {
        try {
            const ticker = $("ticker").value.trim().toUpperCase();
            const prices = await getHistoricalPrices(ticker || "VTI", "10y", "1d");
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
    const rothStartingFuture = currentRoth * Math.pow(1 + expectedReturn, years);
    const tradStartingFuturePreTax = currentTrad * Math.pow(1 + expectedReturn, years);
    const tradStartingFutureAfterTax = tradStartingFuturePreTax * (1 - retireTax);

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
        lifeExpectancy
    }) {
        const chartData = [];
        const totalYears = lifeExpectancy - currentAge;

        let roth = currentRoth;
        let trad = currentTrad;

        let tradAt73 = null;

        for (let i = 0; i < totalYears; i++) {
            const age = currentAge + i;

            // Determine return for this year
            let mu = expectedReturn;
            if (useGlidepath && yearlyExpectedReturns) {
                mu = yearlyExpectedReturns[i] || yearlyExpectedReturns[yearlyExpectedReturns.length - 1];
            }

            // Apply growth
            roth *= (1 + mu);
            trad *= (1 + mu);

            // Apply contributions only before retirement
            if (age < retirementAge) {
                roth += rothContribution;
                trad += contribution;
            }

            // Apply withdrawals after retirement (need-based OR RMD, whichever is larger)
            let withdrawal = undefined;
            let taxDrag = undefined;
            let rmdComponent = 0;
            let ssIncome = age >= claimAge ? ssAnnualStatement : 0;

            if (age >= retirementAge) {

                // 1) Need-based withdrawal (after-tax)
                const needBasedNet = Math.max(spendingNeed - ssIncome, 0);

                // 2) Compute RMD (gross)
                let rmdGross = 0;
                if (age >= 73 && trad > 0) {
                    const divisor = getRmdDivisor(age);
                    rmdGross = trad / divisor;
                }

                // After-tax RMD
                const rmdNet = rmdGross * (1 - retireTax);

                // 3) Total after-tax cash required this year
                //    = RMD net + any additional need beyond RMD
                const extraNeedNet = Math.max(needBasedNet - rmdNet, 0);
                const targetNet = rmdNet + extraNeedNet;

                // 4) Withdraw RMD gross from Traditional (always)
                let tradGrossActual = Math.min(trad, rmdGross);
                let tradNet = tradGrossActual * (1 - retireTax);

                // Track RMD component for tooltip
                rmdComponent = Math.round(tradNet);

                // 5) If extra need exists, fund it:
                //    First from Traditional (grossed up), then Roth
                if (extraNeedNet > 0) {

                    // Gross needed from Traditional to cover extra need
                    const extraTradGrossNeeded = extraNeedNet / (1 - retireTax);

                    // Actual gross from Traditional
                    const extraTradGrossActual = Math.min(trad - tradGrossActual, extraTradGrossNeeded);
                    const extraTradNet = extraTradGrossActual * (1 - retireTax);

                    tradGrossActual += extraTradGrossActual;
                    tradNet += extraTradNet;

                    // If still short, take from Roth (no tax)
                    const remainingNet = extraNeedNet - extraTradNet;
                    const rothActual = Math.min(roth, remainingNet);

                    roth -= rothActual;
                    trad -= extraTradGrossActual;

                    withdrawal = Math.round(tradNet + rothActual);
                    taxDrag = Math.round(tradGrossActual * retireTax);

                } else {
                    // No extra need — only RMD
                    trad -= tradGrossActual;
                    withdrawal = Math.round(tradNet);
                    taxDrag = Math.round(tradGrossActual * retireTax);
                }
            }

            if (age === 73) {
                tradAt73 = trad; // pre-tax Traditional balance at 73
            }
            
            

            // Determine glidepath allocation (if enabled)
            let stockWeight = undefined;
            let bondWeight = undefined;

            if (useGlidepath && typeof getGlidepathAllocation === "function") {
                const alloc = getGlidepathAllocation(age, retirementAge);
                stockWeight = alloc.stockWeight;
                bondWeight = alloc.bondWeight;
            }

            // Determine volatility for this year (if glidepath)
            const vol = yearlyVols ? yearlyVols[i] : undefined;

            // Determine contribution (pre‑retirement)
            const contributionThisYear = age < retirementAge ? contribution : undefined;

            // Now push the FINAL values for this year
            chartData.push({
                age,
                roth,
                trad,

                // Hover insights
                mu,
                vol,
                stockWeight,
                bondWeight,
                contribution: contributionThisYear,
                withdrawal,
                ssIncome,
                taxDrag,
                rmdComponent
            });

        }

        // console.log("Ages in chartData:", chartData.map(d => d.age).join(", "));


        return {
            chartData,
            tradAt73
        };
    }

    /* ---------------------------------------------------
       BUILD & RENDER GROWTH CHART
    --------------------------------------------------- */

    const { chartData, tradAt73 } = buildDeterministicChart({
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

    const phases = buildPhases(currentAge, lifeExpectancy);

    const tradAtRetirement =
        chartData.find(row => row.age === retirementAge)?.trad || 0;

    renderGrowthChart(chartData, phases, currentAge, lifeExpectancy);
    

    /* ---------------------------------------------------
    BUILD & RENDER TAX CHART (USING REAL tradAt73)
 --------------------------------------------------- */

    // Compute RMD from the actual deterministic Traditional balance at 73
    const rmdDivisor = getRmdDivisor(73);
    const rmd = tradAt73 ? tradAt73 / rmdDivisor : 0;

    // Compute taxable Social Security (use your existing function)
    const taxableSS = computeTaxableSS(ssAnnualStatement, filingStatus);

    // Build the tax estimate details using REAL values
    retirementTaxDetails = {
        tradAtRetirement,          // whatever you already compute elsewhere
        tradAt73,                  // <-- from deterministic engine
        rmd,                       // <-- computed from tradAt73
        ssAtClaimAge: ssAnnualStatement,
        taxableSS,
        taxableIncome: rmd + taxableSS,
        estimatedRate: retireTax,
        filingStatus
    };

    // Render the tax chart using the updated details
    renderTaxChart({
        contribution,
        expectedReturn,
        years,
        currentTax,
        rothFinal,
        retirementTaxDetails
    });
 
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
    const taxContext = retirementTaxDetails ? {
        currentTax,
        retireTax,
        filingStatus,
        currentAge,
        retirementAge,
        rmd: retirementTaxDetails.rmd,
        taxableIncome: retirementTaxDetails.taxableIncome,
        grossIncome: retirementTaxDetails.grossIncome
    } : null;

    const result = {
        mode,
        assumedGrowthRate: Finance.round(expectedReturn * 100, 2) + "%",
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
        taxContext,
        expectedReturn,
        stockVol,

        glidepath: useGlidepath ? {
            yearlyExpectedReturns,
            yearlyVols,
            glidepathStockTicker,
            glidepathBondTicker
        } : null
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
                const c = Finance.correlation(dailyReturns[a], dailyReturns[b]);
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
            variance += weights[i] * weights[j] * vols[a] * vols[b] * corr[`${a}-${b}`];
        }
    }

    return Math.sqrt(variance);
}

const glidepathStockTicker = "FXAIX";
const glidepathBondTicker = "FXNAX";


function getGlidepathAllocation(age, retirementAge) {
    // Returns { stockWeight, bondWeight } as decimals (0–1)
    if (age < retirementAge - 10) {
        // Aggressive
        return { stockWeight: 1.0, bondWeight: 0.0 };
    } else if (age < retirementAge - 2) {
        // Moderate
        return { stockWeight: 0.65, bondWeight: 0.35 };
    } else if (age < 70) {
        // Preserve
        return { stockWeight: 0.50, bondWeight: 0.50 };
    } else {
        // Legacy
        return { stockWeight: 0.35, bondWeight: 0.65 };
    }
}


/* -------------------------------------------------------
   YEARLY CURVES FOR CHART
------------------------------------------------------- */

function buildYearlyCurves({ contribution, rothContribution, expectedReturn, years, retireTax, currentRoth, currentTrad }) {
    const roth = [];
    const trad = [];

    let rothBal = currentRoth;
    let tradBal = currentTrad;

    for (let year = 1; year <= years; year++) {
        // rothBal = rothBal * (1 + rate) + rothContribution; updated (and the variable in the function a few lines up)
        // tradBal = tradBal * (1 + rate) + contribution; updated

        rothBal = rothBal * (1 + expectedReturn) + rothContribution;
        tradBal = tradBal * (1 + expectedReturn) + contribution;

        roth.push({ year, balance: rothBal });
        trad.push({ year, balance: tradBal * (1 - retireTax) });
    }

    return { roth, trad };
}


/* -------------------------------------------------------
   CHARTS
------------------------------------------------------- */

function renderGrowthChart(chartData, phases, currentAge, lifeExpectancy) {
    const ctx = $("growthChart").getContext("2d");

    console.log("renderGrowthChart args:", { currentAge, lifeExpectancy });


    if (growthChart) growthChart.destroy();

    growthChart = new Chart(ctx, {
        type: "line",
        data: {
            // labels: chartData.map(d => d.age),
            datasets: [
                {
                    label: "Roth (after-tax)",
                    data: chartData.map(d => ({ x: d.age, y: d.roth })),
                    borderColor: "blue",
                    fill: false
                },
                {
                    label: "Traditional (after-tax)",
                    data: chartData.map(d => ({ x: d.age, y: d.trad })),
                    borderColor: "red",
                    fill: false
                }
            ]
        },

        options: {
            plugins: {
                phaseShading: {
                    phases: phases
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const index = context.dataIndex;
                            const point = chartData[index];

                            let lines = [];

                            lines.push(`${context.dataset.label}: $${context.parsed.y.toLocaleString()}`);

                            if (point.mu !== undefined) {
                                lines.push(`Return: ${(point.mu * 100).toFixed(2)}%`);
                            }

                            if (point.vol !== undefined) {
                                lines.push(`Volatility: ${(point.vol * 100).toFixed(2)}%`);
                            }

                            if (point.stockWeight !== undefined && point.bondWeight !== undefined) {
                                lines.push(
                                    `Allocation: ${(point.stockWeight * 100).toFixed(0)}% stocks / ${(point.bondWeight * 100).toFixed(0)}% bonds`
                                );
                            }

                            if (point.contribution !== undefined) {
                                lines.push(`Contribution: $${point.contribution.toLocaleString()}`);
                            }

                            if (point.withdrawal !== undefined) {
                                lines.push(`Withdrawal: $${point.withdrawal.toLocaleString()}`);
                            }

                            if (point.ssIncome !== undefined) {
                                lines.push(`Social Security: $${point.ssIncome.toLocaleString()}`);
                            }

                            if (point.taxDrag !== undefined) {
                                lines.push(`Tax drag: $${point.taxDrag.toLocaleString()}`);
                            }

                            if (context.raw.rmdComponent > 0) {
                                lines.push(`RMD component: $${context.raw.rmdComponent.toLocaleString()}`);
                            }

                            if (point.age === 73) {
                                lines.push("Note: Hover withdrawal is net; tax table RMD is gross.");
                            }

                            
                            return lines;
                        }
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
                    title: { text: "Value ($)", display: true }
                }
            }
        },

        plugins: [phaseShadingPlugin]   // ← this was missing in your pasted version
    });

    }
    

function renderTaxChart({ contribution, expectedReturn, years, currentTax, rothFinal }) {
    const ctx = $("taxChart").getContext("2d");

    const labels = [];
    const tradValues = [];

    for (let t = 0; t <= 50; t += 1) {
        const retireTax = t / 100;
        let tradBal = 0;

        for (let year = 1; year <= years; year++) {
            // tradBal = tradBal * (1 + rate) + contribution; and the function call a few lines up
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
                        callback: v => `$${v.toLocaleString()}`
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
        // If we don't have volatility or return, we cannot simulate
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

    // Box–Muller normal random generator
    function randomNormal() {
        const u1 = Math.random();
        const u2 = Math.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    for (let run = 0; run < runs; run++) {
        let rothBal = currentRoth;
        let tradBal = currentTrad;

        for (let day = 0; day < totalDays; day++) {
            // Generate a normally distributed daily return
            const z = randomNormal();

            const { dailyMean, dailyStd } = getDailyParams(day);
            const r = dailyMean + dailyStd * z;


            // Apply growth
            rothBal *= (1 + r);
            tradBal *= (1 + r);

            // Monthly contributions (every ~21 trading days)
            if (day % 21 === 0) {
                rothBal += rothContribution / 12;
                tradBal += contribution / 12;
            }
        }

        rothResults.push(rothBal);
        tradResults.push(tradBal * (1 - retireTax));
    }

    // Summaries
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

    console.log("computeProInsights START");

    // -------------------------------------------------------
    // 4% / 5% WITHDRAWAL HELPERS
    // -------------------------------------------------------
    function simulateWithdrawal(balance, rate, growthRate, years) {
        const annual = balance * rate;
        let b = balance;

        for (let i = 0; i < years; i++) {
            b = b * (1 + growthRate) - annual;
            if (b <= 0) return 0;
        }
        return b;
    }

    function runMonteCarlo({
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
                // Random growth using normal distribution
                const rand = Math.random();
                const z = Math.sqrt(-2 * Math.log(rand)) * Math.cos(2 * Math.PI * rand);
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
        const endBalance = simulateWithdrawal(balance, rate, growthRate, years);
        return {
            rate,
            annual: balance * rate,
            endBalance,
            sustainable: endBalance > 0
        };
    }

    // -------------------------------------------------------
    // INPUT EXTRACTION
    // -------------------------------------------------------
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

    // NEW: 4%/5% INSIGHT DEFAULTS
    let fourPercent = null;
    let fivePercent = null;

    let retirementReadiness = null;

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
        // BRACKET INSIGHTS
        // -------------------------------------------------------
        if (currentBracket) {
            currentBracketRate = currentBracket.rate;
            currentBracketFill = Math.max(currentBracket.top - taxable, 0);

            if (nextBracket) {
                nextBracketFill = Math.max(nextBracket.top - taxable, 0);
                nextBracketRate = nextBracket.rate;
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
        // SAFE CONVERSION RANGE
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
        // SIMULATION: SAFE CONVERSIONS UNTIL 73
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
        // MAXIMUM ALLOWABLE CONVERSION
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

        const yearsTo85 = Math.max(0, 85 - retirementAge);
        // -------------------------------------------------------
        // Compute retirement-phase growth rate from glidepath
        // -------------------------------------------------------
        let retirementGrowthRate = 0.05; // fallback default

        if (Array.isArray(glidepath) && glidepath.length > 0) {
            const start = yearsToRetirement;
            const end = yearsToRetirement + yearsTo85;

            // Slice the glidepath for retirement years only
            const retirementReturns = glidepath.slice(start, end);

            if (retirementReturns.length > 0) {
                // Average the retirement-year returns
                retirementGrowthRate =
                    retirementReturns.reduce((sum, r) => sum + r, 0) /
                    retirementReturns.length;
            }
        }

        console.log("Retirement-phase growth rate:", retirementGrowthRate);
        

        // -------------------------------------------------------
        // 4% / 5% WITHDRAWAL SUSTAINABILITY
        // -------------------------------------------------------
        const retirementBalance =
            (result.retirementTaxDetails?.tradAtRetirement ?? 0) +
            (result.rothFinal ?? 0);

        console.log("Retirement balance used for 4%/5%:", retirementBalance);

        const growthRate = retirementGrowthRate;
        
        fourPercent = withdrawalInsight(
            retirementBalance,
            0.04,
            growthRate,
            yearsTo85
        );

        fivePercent = withdrawalInsight(
            retirementBalance,
            0.05,
            growthRate,
            yearsTo85
        );


        // -------------------------------------------------------
        // RETIREMENT READINESS GAUGE (MONTE CARLO)
        // -------------------------------------------------------
        const mcStartingBalance = currentRoth + currentTrad;
        const mcWithdrawal = mcStartingBalance * 0.04; // 4% baseline
        const mcYears = Math.max(0, 85 - retirementAge);
        const mcMeanGrowth = parseFloat(result.assumedGrowthRate) / 100 || 0.07;



        retirementReadiness = runMonteCarlo({
            startingBalance: mcStartingBalance,
            annualWithdrawal: mcWithdrawal,
            years: mcYears,
            meanGrowth: mcMeanGrowth,
            stdev: 0.12,
            simulations: 500,
            readinessThreshold: 500000
        });

        console.log("Readiness result:", retirementReadiness);

    }

    console.log("computeProInsights END");


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
        taxJump,
        fourPercentInsight: fourPercent,
        fivePercentInsight: fivePercent,
        retirementReadiness
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
        maxConversion,
        currentBracketFill,
        nextBracketFill,
        currentBracketRate,
        nextBracketRate,
        taxJump,
        fourPercentInsight: fourPercent,
        fivePercentInsight: fivePercent,
        retirementReadiness

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
        const totalRoom = nextBracketFill;
        const roomInCurrent = currentBracketFill;
        const roomInNext = nextBracketFill - currentBracketFill;

        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Bracket Fill Opportunity</div>
                <div>
                    <strong>Total space before you spill beyond the next tax bracket:</strong>
                    $${totalRoom.toLocaleString()}
                </div>
    
                <div class="pro-insights-note">
                    The first $${roomInCurrent.toLocaleString()} fills the rest of the 
                    <strong>${(currentBracketRate * 100).toFixed(0)}% bucket</strong>.<br>
                    The remaining $${roomInNext.toLocaleString()} fills the 
                    <strong>${(nextBracketRate * 100).toFixed(0)}% bucket</strong>.
                </div>
            </div>
    
            <div class="pro-insights-metric">
                <div class="pro-insights-label">Tax Bracket Insights</div>
    
                <div>
                    <strong>Room left in the ${(currentBracketRate * 100).toFixed(0)}% bracket:</strong>
                    $${roomInCurrent.toLocaleString()}
                </div>
    
                <div>
                    <strong>Additional room in the ${(nextBracketRate * 100).toFixed(0)}% bracket:</strong>
                    $${roomInNext.toLocaleString()}
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

    if (fourPercent && fivePercent) {
        html += `
            <div class="pro-insights-metric">
                <div class="pro-insights-label">4% / 5% Withdrawal Sustainability</div>
    
                <div class="withdrawal-row">
                    <div class="withdrawal-label">4% Rule</div>
                    <div class="withdrawal-value ${fourPercent.sustainable ? "good" : "bad"}">
                        ${fourPercent.sustainable ? "Sustainable" : "Not Sustainable"}
                        <span class="withdrawal-sub">
                            First-year withdrawal: ${formatCurrency(fourPercent.annual)}<br>
                            Projected balance at age 85: ${formatCurrency(fourPercent.endBalance)}
                        </span>
                    </div>
                </div>
    
                <div class="withdrawal-row">
                    <div class="withdrawal-label">5% Rule</div>
                    <div class="withdrawal-value ${fivePercent.sustainable ? "warn" : "bad"}">
                        ${fivePercent.sustainable ? "Borderline" : "Not Sustainable"}
                        <span class="withdrawal-sub">
                            First-year withdrawal: ${formatCurrency(fivePercent.annual)}<br>
                            Projected balance at age 85: ${formatCurrency(fivePercent.endBalance)}
                        </span>
                    </div>
                </div>
            </div>
        `;
    }

    // -------------------------------------------------------
    // RETIREMENT READINESS GAUGE  (⭐ now correctly placed)
    // -------------------------------------------------------
    if (retirementReadiness !== null) {

        let readinessClass = "bad";
        if (retirementReadiness >= 90) readinessClass = "good";
        else if (retirementReadiness >= 60) readinessClass = "warn";

        let readinessLabel = "Low Readiness";
        if (retirementReadiness >= 90) readinessLabel = "High Readiness";
        else if (retirementReadiness >= 60) readinessLabel = "Moderate Readiness";

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
            const growthRate = result.expectedReturn || 0.07;

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

