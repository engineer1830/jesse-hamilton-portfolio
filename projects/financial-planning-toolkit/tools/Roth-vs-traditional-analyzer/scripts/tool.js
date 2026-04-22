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
    const year = engineYears.find(y => y.combinedBalance <= 0);
    return year ? year.age : null;
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
    const currentRoth = parseFloat($("currentRoth").value) || 0;
    const currentTrad = parseFloat($("currentTrad").value) || 0;

    const contribution = parseFloat($("contribution").value) || 0;

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
    const ssAnnualStatement = $("ssAnnual")
        ? parseFloat($("ssAnnual").value) || 0
        : 0;
    const claimAge = $("claimAge")
        ? parseInt($("claimAge").value) || 67
        : 67;
    const filingStatus = $("filingStatus")
        ? $("filingStatus").value || "married"
        : "married";
    const spendingNeed = $("spendingNeed")
        ? parseFloat($("spendingNeed").value) || 0
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
        filingStatus
    }) {
        const engineYears = [];
        
        const totalYears = lifeExpectancy - currentAge;

        let roth = currentRoth;
        let trad = currentTrad;

        for (let i = 0; i < totalYears; i++) {
            const age = currentAge + i;

            // Determine return for this year
            let mu = expectedReturn;
            if (useGlidepath && yearlyExpectedReturns) {
                mu = yearlyExpectedReturns[i] ??
                    yearlyExpectedReturns[yearlyExpectedReturns.length - 1];
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
            rmd: retirementTaxDetails.rmd,
            taxableIncome: retirementTaxDetails.taxableIncome,
            grossIncome: retirementTaxDetails.grossIncome
        }
        : null;

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
    const curves = buildYearlyCurves(
        engineYears,
        result.withdrawalReport?.combinedDepletionAge ??
        result.depletionAge
    );

    const phases = buildPhases(currentAge, lifeExpectancy);

    renderGrowthChart(curves, phases, currentAge, lifeExpectancy);

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

    // ⭐ Override withdrawalReport depletion ages with deterministic truth
    withdrawalReport.tradDepletionAge = tradDepletionAge;
    withdrawalReport.rothDepletionAge = rothDepletionAge;
    withdrawalReport.combinedDepletionAge =
        Math.max(tradDepletionAge || 0, rothDepletionAge || 0);


    // ⭐ Align yearsUntilDepletion with deterministic engine
    withdrawalReport.yearsUntilDepletion =
        withdrawalReport.combinedDepletionAge - retirementAge;
    
    console.log("AFTER OVERRIDE (immediately):", {
        tradDepletionAge,
        rothDepletionAge,
        combinedFromOverride: withdrawalReport.combinedDepletionAge,
        withdrawalReportSnapshot: { ...withdrawalReport }
    });
        
    
    result.withdrawalReport = withdrawalReport;

    console.log("withdrawalReport at summary:", result.withdrawalReport);

    // 3) compute insights
    const insights = computeProInsights(result);

    // 4) merge everything into a single object
    const full = {
        ...result,
        ...insights,
        withdrawalReport
    };

    // 5) render summary with the merged object
    renderSummary(full);

    loading.style.display = "none";
    output.textContent = JSON.stringify(full, null, 2);

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

function renderGrowthChart(curves, phases, currentAge, lifeExpectancy) {
    const ctx = $("growthChart").getContext("2d");

    if (growthChart) growthChart.destroy();

    const { labels, roth, trad, combined, depletionAge } = curves;

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
                phaseShading: { phases },

                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const datasetLabel = context.dataset.label;
                            const value = context.parsed.y;
                            return `${datasetLabel}: ${formatCurrency(value)}`;
                        }
                    }
                },

                // Depletion marker (if applicable)
                annotation: depletionAge
                    ? {
                        annotations: {
                            depletionLine: {
                                type: "line",
                                xMin: depletionAge,
                                xMax: depletionAge,
                                borderColor: "#d32f2f",
                                borderWidth: 1.5,
                                borderDash: [6, 4],
                                label: {
                                    enabled: true,
                                    content: `Depletion age ${depletionAge}`,
                                    position: "start",
                                    backgroundColor: "#d32f2f",
                                    color: "#fff"
                                }
                            }
                        }
                    }
                    : {}
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
    let rothAtRetirement = result.rothAtRetirement ?? 0;
    let rothFirstWithdrawalAge = tradDepletionAge;


    let withdrawalStrategyLabel = "Traditional first (RMDs + spending), Roth last for flexibility and tax‑free growth.";

    let zone = null;

    const glidepath = result.glidepath?.yearlyExpectedReturns || null;

    const growthRate = result.expectedReturn ?? 0.05;
    const startAge = result.taxContext?.retirementAge ?? 65;

    let tradAtRetirement = result.retirementTaxDetails?.tradAtRetirement ?? 0;
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


        // Use the same combined depletion age used everywhere else
        const combinedAge =
            result.withdrawalReport?.combinedDepletionAge ??
            result.depletionAge ??
            overallDepletionAge; // fallback

        depletionAge = combinedAge;
        yearsUntilDepletion = Math.max(0, combinedAge - currentAge);
            
        
        catastrophic =
            requiredWithdrawalRate > 0.06 ||
            retirementReadiness < 50 ||
            yearsUntilDepletion < 20 ||
            depletionAge < 90;

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
                depletionAge < 95 ||                  // depletion inside longevity window
                retirementReadiness < 80              // not catastrophic, but not robust
            )
        ) {
            zone = "yellow";
        }
        


    }


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
        yearsUntilDepletion,
        depletionAge,
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

    // ⭐ Force Chrome to repaint the entire section
    const section = document.getElementById("sustainability-section");
    void section.offsetHeight;
}

function renderWithdrawalStrategy(data) {
    // Strategy label
    setText("withdrawal-strategy-label", data.withdrawalStrategyLabel);

    // Balances at retirement
    setText("trad-balance-at-retirement", formatCurrency(data.tradAtRetirement));
    setText("roth-balance-at-retirement", formatCurrency(data.rothAtRetirement));

    // ⭐ Combined depletion age (the ONLY depletion age we show)
    const combinedAge = data.withdrawalReport?.combinedDepletionAge
        ?? data.depletionAge
        ?? null;

    setText(
        "combined-depletion-age",
        combinedAge
            ? `Age ${combinedAge}`
            : "N/A"
    );

    // ⭐ Remove account-specific depletion ages from UI
    // (We intentionally do NOT set trad-depletion-age or roth-depletion-age anymore)
    setText("trad-depletion-age", "—");
    setText("roth-depletion-age", "—");

    // First-year withdrawals
    setText(
        "trad-first-year-withdrawal",
        formatCurrency(data.tradFirstYearWithdrawal)
    );
    setText(
        "roth-first-year-withdrawal",
        formatCurrency(data.rothFirstYearWithdrawal)
    );

    // RMD snapshots
    setText("trad-rmd-73", formatCurrency(data.tradRmdAt73));
    setText("trad-rmd-80", formatCurrency(data.tradRmdAt80));
    setText("trad-rmd-90", formatCurrency(data.tradRmdAt90));

    // Required withdrawal rate
    setText(
        "required-withdrawal-rate",
        formatPercent(data.requiredWithdrawalRate)
    );
}


function renderPositiveSustainability({ depletionAge, yearsLeft, withdrawalRate, spendingGap, successRate, result }) {

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("positive-title", "Your Plan Appears Sustainable");

    // Subtitle
    setText(
        "positive-subtitle",
        `Your savings are projected to last through age ${depletionAge}, providing a strong buffer for longevity and market variability.`
    );

    // Key metrics
    setText("positive-withdrawal-rate", formatPercent(withdrawalRate));
    setText("positive-withdrawal-need", formatCurrency(spendingGap));
    setText("positive-ss-income", formatCurrency(ss));

    // Confidence bar (Monte Carlo success rate)
    const bar = document.getElementById("sustain-bar-fill");
    bar.style.width = `${Math.min(Math.max(successRate, 0), 100)}%`;

    // Why this result occurred
    setText("positive-why-1", "Your projected depletion age provides a strong longevity buffer.");
    setText("positive-why-2", "Your withdrawal need is within a range your portfolio can support.");
    setText("positive-why-3", "Your savings continue to grow or remain stable throughout retirement.");
}

function renderYellowSustainability({ depletionAge, yearsLeft, withdrawalRate, spendingGap, result }) {

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("yellow-title", "Your Plan Is Workable, But Sensitive to Market Conditions");

    // Subtitle
    setText(
        "yellow-subtitle",
        `Your savings may be depleted near age ${depletionAge} (in ${yearsLeft} years), and the plan has limited buffer for volatility or higher‑than‑expected spending.`
    );

    // Key metrics
    setText("yellow-withdrawal-rate", formatPercent(withdrawalRate));
    setText("yellow-spending-gap", formatCurrency(spendingGap));
    setText("yellow-ss-income", formatCurrency(ss));

    // Why this result occurred
    setText("yellow-why-1", "Your withdrawal need is above the typical safe spending range.");
    setText("yellow-why-2", "Your withdrawal rate is near the upper edge of the 4%–5% guideline.");
    setText("yellow-why-3", "Your portfolio is doing most of the work relative to Social Security.");
    setText("yellow-why-4", "Your projected depletion age leaves less room for longevity or market shocks.");
}

function renderNegativeSustainability({ depletionAge, yearsLeft, withdrawalRate, spendingGap, result }) {

    const ss = result.retirementTaxDetails?.ssAtClaimAge ?? 0;

    // Title
    setText("catastrophic-title", "Your Current Plan Needs Adjustment");

    // Subtitle
    setText(
        "catastrophic-subtitle",
        `Your savings may be depleted near age ${depletionAge} (in ${yearsLeft} years), indicating a high risk of running out of money in retirement.`
    );

    // Key metrics
    setText("catastrophic-withdrawal-rate", formatPercent(withdrawalRate));
    setText("catastrophic-spending-gap", formatCurrency(spendingGap));
    setText("catastrophic-ss-income", formatCurrency(ss));

    // Why this result occurred
    setText("catastrophic-why-1", "Your withdrawal rate exceeds sustainable levels.");
    setText("catastrophic-why-2", "Your projected depletion age is inside the longevity risk window.");
    setText("catastrophic-why-3", "Your retirement readiness score indicates limited resilience.");
    setText("catastrophic-why-4", "Your plan may not withstand typical market variability.");
}

// ⭐ Longevity Buffer Score (0–100)
function computeLongevityBufferScore(yearsUntilDepletion) {
    const score = (yearsUntilDepletion / 40) * 100;
    return Math.min(100, Math.max(0, Math.round(score)));
}

// ⭐ Spending Tier Classification
function classifySpendingTier(result) {
    const w = result.requiredWithdrawalRate; // decimal
    const y = result.yearsUntilDepletion;
    const catastrophic = result.catastrophic;
    const buffer = computeLongevityBufferScore(y);

    if (w <= 0.05) {
        return "classic-safe";
    }

    if (w > 0.05 && w <= 0.075 && buffer >= 60 && !catastrophic) {
        return "elevated-supported";
    }

    if (w > 0.075 && buffer >= 80 && !catastrophic) {
        return "aggressive-but-supported";
    }

    return "unsustainable";
}
// ⭐ Messaging: Classic Safe (≤5%)
function messageClassicSafe(result) {
    return {
        title: "Your Plan Appears Sustainable",
        bullets: [
            "Your withdrawal rate is within the traditional 4–5% guideline.",
            `Your portfolio is projected to last through age ${result.depletionAge}.`,
            "Your savings remain stable or continue to grow throughout retirement."
        ]
    };
}

// ⭐ Messaging: Elevated Supported (5%–7.5%)
function messageElevatedSupported(result) {
    const buffer = computeLongevityBufferScore(result.yearsUntilDepletion);

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
    const buffer = computeLongevityBufferScore(result.yearsUntilDepletion);

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
    const msg = getSpendingMessage(insights);
    const zone = insights.zone;

    const tier = classifySpendingTier(insights);
    const buffer = computeLongevityBufferScore(insights.yearsUntilDepletion);

    const titleId = `spending-title-${zone}`;
    const listId = `spending-bullets-${zone}`;

    const titleEl = document.getElementById(titleId);
    const listEl = document.getElementById(listId);

    if (!titleEl || !listEl) return;

    // Reset tier classes
    titleEl.classList.remove("tier-classic", "tier-elevated", "tier-aggressive", "tier-unsustainable");

    // Apply tier class
    switch (tier) {
        case "classic-safe":
            titleEl.classList.add("tier-classic");
            break;
        case "elevated-supported":
            titleEl.classList.add("tier-elevated");
            break;
        case "aggressive-but-supported":
            titleEl.classList.add("tier-aggressive");
            break;
        default:
            titleEl.classList.add("tier-unsustainable");
    }

    // ⭐ Write title + buffer badge
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
            "The growth chart shows projected balances year-by-year, " +
            "but the depletion age is based on the sustainability engine, " +
            "which includes taxes, Social Security timing, and spending patterns. " +
            "These models use different assumptions, so the depletion age may not " +
            "match the exact point where the chart crosses zero."
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
                    $${fmt(totalRoom) }
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

    const diffLabel =
        difference >= 0 ? "Roth ahead by" : "Traditional ahead by";

    const combinedAge =
        data.withdrawalReport?.combinedDepletionAge ??
        data.depletionAge ??
        null;

    let html = `
        <h3>Projected Depletion Age</h3>
        <div class="depletion-component">
            <p>Your total retirement assets are projected to run out around
            <strong>age ${combinedAge}</strong>.</p>
            <p>This is the earliest point at which your plan can no longer support
            your spending level.</p>
        </div>
    
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
            <h3>Retirement Tax Estimate</h3>
            <table class="summary-table">
                <tr><td>Estimated RMD at 73</td><td>${formatCurrency(t.rmd)}</td></tr>
                <tr><td>Estimated Social Security (at claim age)</td><td>${formatCurrency(t.ssAtClaimAge)}</td></tr>
                <tr><td>Estimated Taxable Social Security</td><td>${formatCurrency(t.taxableSS)}</td></tr>
                <tr><td>Estimated Taxable Income</td><td>${formatCurrency(t.taxableIncome)}</td></tr>
                <tr><td>Estimated Retirement Tax Rate</td><td>${formatPercent(t.estimatedRate)}</td></tr>
            </table>
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

    // ⭐ FIXED: insights must be based on data
    const insights = computeProInsights(data);

    showSustainability(insights.zone);

    if (insights.zone === "red") {
        renderNegativeSustainability({
            depletionAge: insights.depletionAge,
            yearsLeft: insights.yearsUntilDepletion,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            result: data
        });
    } else if (insights.zone === "yellow") {
        renderYellowSustainability({
            depletionAge: insights.depletionAge,
            yearsLeft: insights.yearsUntilDepletion,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            result: data
        });
    } else {
        renderPositiveSustainability({
            depletionAge: insights.depletionAge,
            yearsLeft: insights.yearsUntilDepletion,
            withdrawalRate: insights.requiredWithdrawalRate,
            spendingGap: insights.spendingGap,
            successRate: insights.retirementReadiness,
            result: data
        });
    }

    // ⭐ Elevated Spending Messaging
    renderSpendingMessage(insights);

    // ⭐ FIXED: use data
    // renderWithdrawalStrategy(
    //     data.withdrawalReport,
    //     {
    //         tradAtRetirement: data.tradAtRetirement,
    //         rothAtRetirement: data.rothAtRetirement
    //     }
    // );

    renderWithdrawalStrategy(data);


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

function renderCatastrophicUX(result) {
    const bannerEl = document.getElementById("catastrophic-banner");
    const sanityEl = document.getElementById("sanity-check");
    const actionsEl = document.getElementById("recommended-actions");
    const depletionMsgEl = document.getElementById(
        "catastrophic-depletion-message"
    );

    if (!bannerEl || !sanityEl || !actionsEl) return;

    const catastrophic = !!result.catastrophic;
    const requiredRate = result.requiredWithdrawalRate ?? null;
    const spendingGap = result.spendingGap ?? null;
    const ssIncome =
        result.retirementTaxDetails?.ssAtClaimAge ?? null;
    const yearsUntilDepletion = result.yearsUntilDepletion ?? null;
    const depletionAge = result.depletionAge ?? null;

    const needsAdjustment =
        catastrophic ||
        (requiredRate != null && requiredRate > 0.05) ||
        (result.safeSpendingDelta != null &&
            result.safeSpendingDelta > 0);

    if (depletionMsgEl) {
        if (needsAdjustment && yearsUntilDepletion != null) {
            const depletionLine = depletionAge
                ? `At your current spending level, your savings may be depleted near age <strong>${depletionAge}</strong>.`
                : `At your current spending level, your savings may be depleted well before age 85.`;

            depletionMsgEl.innerHTML = `
                ${depletionLine}
                Your plan requires adjustment to improve long‑term sustainability.
            `;
        } else {
            depletionMsgEl.innerHTML = "";
        }
    }

    if (catastrophic) {
        bannerEl.style.display = "flex";

        const rateEl = document.getElementById(
            "catastrophic-withdrawal-rate"
        );
        const gapEl = document.getElementById(
            "catastrophic-spending-gap"
        );
        const ssEl = document.getElementById("catastrophic-ss-income");

        if (rateEl && requiredRate != null) {
            rateEl.textContent = formatPercent(requiredRate);
        }
        if (gapEl && spendingGap != null) {
            gapEl.textContent = formatCurrency(spendingGap);
        }
        if (ssEl && ssIncome != null) {
            ssEl.textContent = formatCurrency(ssIncome);
        }
    } else {
        bannerEl.style.display = "none";
    }

    let statusLine = "";
    if (catastrophic) {
        statusLine =
            "Yes — at your current spending level, your savings would run out early.";
    } else if (
        requiredRate != null &&
        requiredRate > 0.05 &&
        requiredRate <= 0.08
    ) {
        statusLine =
            "Possibly — your plan is fragile and may not withstand market volatility.";
    } else {
        statusLine =
            "Unlikely — your plan appears sustainable under typical market conditions.";
    }

    const yearsText = yearsUntilDepletion
        ? `Estimated depletion age: <strong>${depletionAge}</strong> (in ${yearsUntilDepletion} years)`
        : "";

    const safeSpendingText =
        needsAdjustment &&
            result.safeSpendingMin != null &&
            result.safeSpendingMax != null
            ? `To stay within the 4%–5% safe range, your sustainable spending level is 
               <strong>${formatCurrency(
                result.safeSpendingMin
            )}–${formatCurrency(
                result.safeSpendingMax
            )}</strong> per year.`
            : "";

    const safeSpendingDelta =
        needsAdjustment && result.safeSpendingDelta != null
            ? result.safeSpendingDelta
            : null;

    const safeDeltaText =
        safeSpendingDelta !== null && safeSpendingDelta > 0
            ? `You would need to reduce spending by 
               <strong>${formatCurrency(
                safeSpendingDelta
            )}</strong> 
               to reach the safe range.`
            : "";

    const requiredPortfolioText =
        needsAdjustment && result.requiredPortfolioSize
            ? `<p class="sanity-required">
                 To safely sustain your current lifestyle, you would need a portfolio of 
                 <strong>${formatCurrency(
                result.requiredPortfolioSize
            )}</strong>.
               </p>`
            : "";

    let statusClass = "";
    let statusIcon = "";

    if (catastrophic) {
        statusClass = "bad";
        statusIcon = "⛔";
    } else if (requiredRate != null && requiredRate > 0.05) {
        statusClass = "warn";
        statusIcon = "⚠️";
    } else {
        statusClass = "good";
        statusIcon = "✓";
    }

    sanityEl.innerHTML = `
        <div class="sanity-block fade-in">
          <h3>Will I Run Out of Money?</h3>

          <p class="sanity-status ${statusClass}">
            <span class="status-icon">${statusIcon}</span>
            ${statusLine}
          </p>

          ${needsAdjustment
            ? `<p class="sanity-detail">
                       Your annual spending need is <strong>${formatCurrency(
                result.spendingNeedAtRetirement ?? 0
            )}</strong>, but your portfolio can safely support only
                       <strong>${formatCurrency(
                result.fourPercentInsight?.annual ?? 0
            )}–${formatCurrency(
                result.fivePercentInsight?.annual ?? 0
            )}</strong> per year under the 4%–5% rule.
                       This mismatch creates a withdrawal rate that leads to early depletion.
                     </p>`
            : ""
        }

          ${yearsText ? `<p class="sanity-years">${yearsText}</p>` : ""}
          ${safeSpendingText
            ? `<p class="sanity-safe">${safeSpendingText}</p>`
            : ""
        }
          ${safeDeltaText
            ? `<p class="sanity-delta">${safeDeltaText}</p>`
            : ""
        }
          ${requiredPortfolioText}
        </div>
    `;

    sanityEl.style.display = "block";

    if (catastrophic) {
        actionsEl.innerHTML = `
            <div class="actions-block fade-in">
              <h3>Recommended Next Steps</h3>
              <ol>
                <li><strong>Reduce annual spending.</strong> Even a 10–20% reduction dramatically improves sustainability.</li>
                <li><strong>Delay retirement.</strong> Each additional year of work increases savings and shortens the withdrawal horizon.</li>
                <li><strong>Increase savings contributions.</strong> Extra savings in the final working years have outsized impact.</li>
                <li><strong>Adjust investment allocation.</strong> A more growth‑oriented mix may improve sustainability but increases volatility.</li>
                <li><strong>Re‑evaluate Social Security timing.</strong> Delaying benefits increases lifetime income and reduces portfolio pressure.</li>
              </ol>
            </div>
        `;
        actionsEl.style.display = "block";
    } else {
        actionsEl.innerHTML = "";
        actionsEl.style.display = "none";
    }
}