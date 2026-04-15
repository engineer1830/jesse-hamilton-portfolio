// /api/yahoo.js
export default async function handler(req, res) {
    const {
        ticker,
        range = "10y",
        interval = "1d"
    } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: "Ticker is required" });
    }

    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;

        const response = await fetch(url, {
            method: "GET",
            cache: "no-store", // prevent Vercel caching
            headers: {
                "User-Agent": "Mozilla/5.0" // prevents Yahoo 403 errors
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({
                error: `Yahoo Finance request failed (${response.status})`
            });
        }

        const json = await response.json();

        // Defensive parsing
        if (!json.chart || !json.chart.result || !json.chart.result[0]) {
            return res.status(404).json({ error: "No data found" });
        }

        const result = json.chart.result[0];
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];

        if (!timestamps.length || !closes.length) {
            return res.status(404).json({ error: "No price data available" });
        }

        // Normalize into { date, close }
        const prices = timestamps
            .map((ts, i) => ({
                date: new Date(ts * 1000).toISOString().split("T")[0],
                close: closes[i]
            }))
            .filter(p => p.close !== null && !isNaN(p.close));

        return res.status(200).json(prices);

    } catch (err) {
        console.error("Yahoo Finance API error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
}
