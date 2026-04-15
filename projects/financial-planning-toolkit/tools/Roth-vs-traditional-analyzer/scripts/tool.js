import { Finance } from "../../../scripts/engine.js";
import { getHistoricalPrices, getMultipleTickers } from "../../../scripts/data.js";
import { calculateCAGR, priceSeriesToDailyReturns } from "../../../scripts/transforms.js";
import { estimateRetirementTaxRate } from "./retirement.js";

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
        monteCarlo,
        retirementTaxDetails
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
        retirementTaxDetails
    } = result;

    const diffLabel = difference >= 0 ? "Roth ahead by" : "Traditional ahead by";

    let html = `
        <h3>Comparison</h3>
        <table class="summary-table">
            <tr>
                <th>Metric</th>
                <th>Roth</th>
                <th>Traditional</th>
            </tr>
            <tr>
                <td>Starting Balance</td>
                <td>$${currentRoth.toLocaleString()}</td>
                <td>$${currentTrad.toLocaleString()}</td>
            </tr>
            <tr>
                <td>Final After-Tax Value</td>
                <td>$${rothFinal.toLocaleString()}</td>
                <td>$${traditionalFinal.toLocaleString()}</td>
            </tr>
            <tr>
                <td>Better Option</td>
                <td colspan="2">${betterOption}</td>
            </tr>
            <tr>
                <td>${diffLabel}</td>
                <td colspan="2">$${Math.abs(difference).toLocaleString()}</td>
            </tr>
            <tr>
                <td>Assumed Growth Rate</td>
                <td colspan="2">${assumedGrowthRate}</td>
            </tr>
            <tr>
                <td>Break-Even Tax Rate</td>
                <td colspan="2">${breakEvenTaxRate}</td>
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
                <tr>
                    <td>Estimated RMD at 73</td>
                    <td>$${t.rmd.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Estimated Social Security (at claim age)</td>
                    <td>$${t.ssAtClaimAge.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Estimated Taxable Social Security</td>
                    <td>$${t.taxableSS.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Estimated Taxable Income</td>
                    <td>$${t.taxableIncome.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Estimated Retirement Tax Rate</td>
                    <td>${(t.estimatedRate * 100).toFixed(1)}%</td>
                </tr>
            </table>
        `;
    }

    if (monteCarlo) {
        html += `
            <h3>Monte Carlo Summary (${monteCarlo.runs} runs)</h3>
            <table class="summary-table">
                <tr>
                    <th></th>
                    <th>10th %ile</th>
                    <th>Median</th>
                    <th>90th %ile</th>
                </tr>
                <tr>
                    <td>Roth</td>
                    <td>$${monteCarlo.roth.p10.toLocaleString()}</td>
                    <td>$${monteCarlo.roth.p50.toLocaleString()}</td>
                    <td>$${monteCarlo.roth.p90.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Traditional</td>
                    <td>$${monteCarlo.traditional.p10.toLocaleString()}</td>
                    <td>$${monteCarlo.traditional.p50.toLocaleString()}</td>
                    <td>$${monteCarlo.traditional.p90.toLocaleString()}</td>
                </tr>
                <tr>
                    <td>Roth Win Probability</td>
                    <td colspan="3">${monteCarlo.rothWinProbability}</td>
                </tr>
            </table>
        `;
    }

    el.innerHTML = html;
}
