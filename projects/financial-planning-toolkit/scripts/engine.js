/* -------------------------------------------------------
   FINANCIAL MATH ENGINE (Shared Across All Tools)
   Clean, modular, reusable — extracted + enhanced
------------------------------------------------------- */

export const Finance = {

    /* ---------------------------------------------------
       BASIC UTILITIES
    --------------------------------------------------- */

    round(value, decimals = 2) {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    },

    clamp(value, min = 0) {
        return Math.max(value, min);
    },

    /* ---------------------------------------------------
       COMPOUNDING & GROWTH
    --------------------------------------------------- */

    // Basic compound growth: FV = PV * (1 + r)^n
    compound(principal, rate, years) {
        return principal * Math.pow(1 + rate, years);
    },

    // Compound growth with contributions
    compoundWithContributions({
        initial = 0,
        annualContribution = 0,
        rate = 0,
        years = 0,
        contributionFrequency = 12
    }) {
        let balance = initial;
        const periodRate = rate / contributionFrequency;
        const periods = years * contributionFrequency;
        const contribution = annualContribution / contributionFrequency;

        for (let i = 0; i < periods; i++) {
            balance = balance * (1 + periodRate) + contribution;
        }

        return balance;
    },

    /* ---------------------------------------------------
       REAL MARKET GROWTH (NEW)
       Uses price series from transforms.js
    --------------------------------------------------- */

    // Apply daily returns to a starting balance
    applyReturnSeries(startBalance, dailyReturns = []) {
        let balance = startBalance;

        for (const r of dailyReturns) {
            balance *= (1 + r.return);
        }

        return balance;
    },

    // Apply daily returns + monthly contributions
    applyReturnSeriesWithContributions({
        startBalance = 0,
        dailyReturns = [],
        monthlyContribution = 0
    }) {
        let balance = startBalance;

        for (let i = 0; i < dailyReturns.length; i++) {
            balance *= (1 + dailyReturns[i].return);

            // Add contribution every ~21 trading days
            if (i % 21 === 0) {
                balance += monthlyContribution;
            }
        }

        return balance;
    },

    /* ---------------------------------------------------
       INFLATION ADJUSTMENT
    --------------------------------------------------- */

    inflationAdjust(amount, inflationRate, years) {
        return amount / Math.pow(1 + inflationRate, years);
    },

    inflationFutureValue(amount, inflationRate, years) {
        return amount * Math.pow(1 + inflationRate, years);
    },

    /* ---------------------------------------------------
       LOAN AMORTIZATION
    --------------------------------------------------- */

    // Standard PMT formula
    pmt(rate, nper, pv) {
        if (rate === 0) return -(pv / nper);
        return -(rate * pv) / (1 - Math.pow(1 + rate, -nper));
    },

    amortizationSchedule({
        principal,
        annualRate,
        years,
        paymentsPerYear = 12
    }) {
        const rate = annualRate / paymentsPerYear;
        const nper = years * paymentsPerYear;
        const payment = this.pmt(rate, nper, principal);

        let balance = principal;
        const schedule = [];

        for (let i = 1; i <= nper; i++) {
            const interest = balance * rate;
            const principalPaid = payment - interest;
            balance -= principalPaid;

            schedule.push({
                period: i,
                payment: this.round(payment),
                interest: this.round(interest),
                principal: this.round(principalPaid),
                balance: this.round(this.clamp(balance))
            });

            if (balance <= 0) break;
        }

        return schedule;
    },

    /* ---------------------------------------------------
       RETIREMENT SIMULATION
       (Extracted, generalized, unchanged)
    --------------------------------------------------- */

    retirementSimulation({
        startBalance = 0,
        annualContribution = 0,
        growthRate = 0.07,
        inflationRate = 0.02,
        yearsToRetirement = 30,
        retirementYears = 30,
        withdrawalRate = 0.04
    }) {
        const accumulation = [];
        const retirement = [];

        let balance = startBalance;

        /* ----- ACCUMULATION PHASE ----- */
        for (let year = 1; year <= yearsToRetirement; year++) {
            balance = balance * (1 + growthRate) + annualContribution;

            accumulation.push({
                year,
                balance: this.round(balance)
            });
        }

        /* ----- RETIREMENT PHASE ----- */
        let withdrawal = accumulation[accumulation.length - 1].balance * withdrawalRate;

        for (let year = 1; year <= retirementYears; year++) {
            if (year > 1) {
                withdrawal *= (1 + inflationRate);
            }

            balance = balance * (1 + growthRate) - withdrawal;

            retirement.push({
                year,
                withdrawal: this.round(withdrawal),
                balance: this.round(this.clamp(balance))
            });

            if (balance <= 0) break;
        }

        return {
            accumulation,
            retirement,
            finalBalance: this.round(balance)
        };
    },

    /* ---------------------------------------------------
       TAX BRACKET ENGINE
    --------------------------------------------------- */

    calculateTax(income, brackets) {
        let tax = 0;
        let remaining = income;

        for (const bracket of brackets) {
            const { limit, rate } = bracket;

            if (remaining <= 0) break;

            if (limit === null) {
                tax += remaining * rate;
                break;
            }

            const taxable = Math.min(remaining, limit);
            tax += taxable * rate;
            remaining -= taxable;
        }

        return this.round(tax);
    },

    /* ---------------------------------------------------
       NET WORTH UTILITIES
    --------------------------------------------------- */

    calculateNetWorth(assets = [], liabilities = []) {
        const totalAssets = assets.reduce((sum, a) => sum + a.amount, 0);
        const totalLiabilities = liabilities.reduce((sum, l) => sum + l.amount, 0);

        return {
            totalAssets: this.round(totalAssets),
            totalLiabilities: this.round(totalLiabilities),
            netWorth: this.round(totalAssets - totalLiabilities)
        };
    }
};
