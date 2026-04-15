/* -------------------------------------------------------
   TRANSFORM LAYER — Convert Price Data → Growth Curves
   Works with data.js + engine.js
------------------------------------------------------- */

/**
 * Convert raw price series into daily returns.
 * Input:  [{ date, close }]
 * Output: [{ date, return }]
 */
export function priceSeriesToDailyReturns(prices) {
    const returns = [];

    for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1].close;
        const curr = prices[i].close;

        // Defensive guard
        if (prev === null || curr === null || prev === 0) continue;

        const r = (curr - prev) / prev;

        returns.push({
            date: prices[i].date,
            return: r
        });
    }

    return returns;
}

/**
 * Convert daily returns → annualized return.
 * Assumes ~252 trading days per year.
 */
export function annualizedReturn(dailyReturns) {
    if (dailyReturns.length === 0) return 0;

    const avgDaily =
        dailyReturns.reduce((s, r) => s + r.return, 0) / dailyReturns.length;

    return Math.pow(1 + avgDaily, 252) - 1;
}

/**
 * Compute CAGR from price series.
 */
export function calculateCAGR(prices) {
    if (prices.length < 2) return 0;

    const start = prices[0].close;
    const end = prices[prices.length - 1].close;

    if (start <= 0 || end <= 0) return 0;

    const ms = new Date(prices[prices.length - 1].date) - new Date(prices[0].date);
    const years = ms / (1000 * 60 * 60 * 24 * 365);

    if (years <= 0) return 0;

    return Math.pow(end / start, 1 / years) - 1;
}

/**
 * Compute volatility (standard deviation of daily returns).
 * Uses sample variance (N-1), annualized.
 */
export function calculateVolatility(dailyReturns) {
    if (dailyReturns.length < 2) return 0;

    const mean =
        dailyReturns.reduce((s, r) => s + r.return, 0) / dailyReturns.length;

    const variance =
        dailyReturns.reduce((s, r) => {
            const diff = r.return - mean;
            return s + diff * diff;
        }, 0) / (dailyReturns.length - 1);

    return Math.sqrt(variance) * Math.sqrt(252); // annualized
}

/**
 * Convert price series → growth curve (normalized to 1.0)
 */
export function priceSeriesToGrowthCurve(prices) {
    if (prices.length === 0) return [];

    const start = prices[0].close;
    if (start <= 0) return [];

    return prices.map(p => ({
        date: p.date,
        growth: p.close / start
    }));
}

/**
 * Convert price series → contribution-adjusted growth curve.
 * Uses monthly contributions by default.
 */
export function priceSeriesWithContributions(
    prices,
    monthlyContribution = 0,
    startBalance = 0
) {
    if (prices.length === 0) return [];

    let balance = startBalance;
    const curve = [];

    for (let i = 0; i < prices.length; i++) {
        if (i > 0) {
            const prev = prices[i - 1].close;
            const curr = prices[i].close;

            if (prev !== null && curr !== null && prev !== 0) {
                const r = (curr - prev) / prev;
                balance = balance * (1 + r);
            }
        }

        // Add monthly contribution every ~21 trading days
        if (i % 21 === 0) {
            balance += monthlyContribution;
        }

        curve.push({
            date: prices[i].date,
            balance
        });
    }

    return curve;
}

/* -------------------------------------------------------
   ADDITIONAL UTILITIES (NEW)
------------------------------------------------------- */

/**
 * Rolling returns over N days.
 */
export function rollingReturns(prices, window = 252) {
    const results = [];

    for (let i = window; i < prices.length; i++) {
        const start = prices[i - window].close;
        const end = prices[i].close;

        if (start && end) {
            results.push({
                date: prices[i].date,
                return: (end - start) / start
            });
        }
    }

    return results;
}

/**
 * Rolling volatility over N days.
 */
export function rollingVolatility(dailyReturns, window = 252) {
    const results = [];

    for (let i = window; i < dailyReturns.length; i++) {
        const slice = dailyReturns.slice(i - window, i);
        const vol = calculateVolatility(slice);

        results.push({
            date: dailyReturns[i].date,
            volatility: vol
        });
    }

    return results;
}