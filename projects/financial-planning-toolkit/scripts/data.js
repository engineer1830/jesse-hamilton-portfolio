/* -------------------------------------------------------
   DATA LAYER — Yahoo Finance Fetcher
   Works with Vercel serverless API routes
------------------------------------------------------- */

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;

    // Expired?
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        cache.delete(key);
        return null;
    }

    return entry.data;
}

/**
 * Fetch historical price data for a ticker.
 * Expected API response format:
 * [
 *   { date: "2020-01-01", close: 123.45 },
 *   { date: "2020-01-02", close: 124.10 },
 *   ...
 * ]
 */
export async function getHistoricalPrices(
    ticker,
    range = "max",
    interval = "1d"
) {
    const key = `${ticker}-${range}-${interval}`;

    // Return cached data if available
    const cached = getCache(key);
    if (cached) return cached;

    try {
        const response = await fetch(
            `/api/yahoo?ticker=${ticker}&range=${range}&interval=${interval}`
        );

        if (!response.ok) {
            console.error(`Yahoo Finance API error: ${response.status}`);
            return [];
        }

        const data = await response.json();

        // Defensive guard — Yahoo sometimes returns empty arrays
        if (!Array.isArray(data) || data.length === 0) {
            console.warn(`No price data returned for ${ticker}`);
            return [];
        }

        // Cache the result
        setCache(key, data);

        return data;

    } catch (err) {
        console.error("Error fetching price data:", err);
        return [];
    }
}

/**
 * Fetch multiple tickers at once.
 * Returns an object keyed by ticker.
 */
export async function getMultipleTickers(
    tickers = [],
    range = "max",
    interval = "1d"
) {
    const results = {};

    for (const t of tickers) {
        results[t] = await getHistoricalPrices(t, range, interval);
    }

    return results;
}
