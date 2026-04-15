import { Finance } from "../../scripts/engine.js";
import { getHistoricalPrices } from "../../scripts/data.js";
import {
    priceSeriesWithContributions,
    calculateCAGR
} from "../../scripts/transforms.js";

const $ = id => document.getElementById(id);

$("runBtn").addEventListener("click", async () => {

    const loading = $("loading");
    const output = $("output");

    // Clear previous output
    output.textContent = "";
    loading.style.display = "block";

    // Parse inputs
    const initial = parseFloat($("initial").value) || 0;
    const contribution = parseFloat($("contribution").value) || 0;
    const years = parseInt($("years").value) || 0;
    const rate = (parseFloat($("rate").value) || 0) / 100;
    const inflation = (parseFloat($("inflation").value) || 0) / 100;
    const ticker = $("ticker").value.trim().toUpperCase();

    let result = {};

    /* ---------------------------------------------------
       OPTION A — Synthetic Growth (No Ticker)
    --------------------------------------------------- */
    if (!ticker) {
        const fv = Finance.compoundWithContributions({
            initial,
            annualContribution: contribution,
            rate,
            years
        });

        const inflationAdjusted = Finance.inflationAdjust(fv, inflation, years);

        result = {
            mode: "synthetic",
            finalValue: Finance.round(fv),
            inflationAdjusted: Finance.round(inflationAdjusted)
        };

        loading.style.display = "none";
        output.textContent = JSON.stringify(result, null, 2);
        return;
    }

    /* ---------------------------------------------------
       OPTION B — Real Growth (Ticker Provided)
    --------------------------------------------------- */

    const prices = await getHistoricalPrices(ticker, "10y", "1d");

    if (!prices.length) {
        loading.style.display = "none";
        output.textContent = `No price data found for ${ticker}`;
        return;
    }

    const cagr = calculateCAGR(prices);

    // Monthly contribution = annual / 12
    const monthlyContribution = contribution / 12;

    const growthCurve = priceSeriesWithContributions(
        prices,
        monthlyContribution,
        initial
    );

    const finalBalance = growthCurve[growthCurve.length - 1].balance;

    const inflationAdjusted = Finance.inflationAdjust(
        finalBalance,
        inflation,
        years
    );

    result = {
        mode: "real",
        ticker,
        cagr: Finance.round(cagr * 100, 2) + "%",
        finalValue: Finance.round(finalBalance),
        inflationAdjusted: Finance.round(inflationAdjusted)
    };

    loading.style.display = "none";
    output.textContent = JSON.stringify(result, null, 2);
});
