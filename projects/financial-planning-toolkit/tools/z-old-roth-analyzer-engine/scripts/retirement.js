import { Finance } from "../../../scripts/engine.js";

// Simplified 2026-ish brackets (can refine later)
const TAX_BRACKETS = {
    single: [
        { upTo: 11000, rate: 0.10 },
        { upTo: 44725, rate: 0.12 },
        { upTo: 95375, rate: 0.22 },
        { upTo: 182100, rate: 0.24 },
        { upTo: 231250, rate: 0.32 },
        { upTo: 578125, rate: 0.35 }
    ],
    married: [
        { upTo: 22000, rate: 0.10 },
        { upTo: 89450, rate: 0.12 },
        { upTo: 190750, rate: 0.22 },
        { upTo: 364200, rate: 0.24 },
        { upTo: 462500, rate: 0.32 },
        { upTo: 693750, rate: 0.35 }
    ]
};

const STANDARD_DEDUCTION = {
    single: 15000,
    married: 30000
};

// Uniform Lifetime Table divisor at age 73 (simplified)
const RMD_DIVISOR_73 = 26.5;

/**
 * Map taxable income → marginal tax rate.
 */
export function taxRateForIncome(taxableIncome, filingStatus = "married") {
    const brackets = TAX_BRACKETS[filingStatus] || TAX_BRACKETS.married;
    for (const b of brackets) {
        if (taxableIncome <= b.upTo) return b.rate;
    }
    return brackets[brackets.length - 1].rate;
}

/**
 * Estimate RMD at age 73 from a projected traditional balance.
 */
export function estimateRMDAt73(tradBalanceAt73) {
    return tradBalanceAt73 / RMD_DIVISOR_73;
}

/**
 * Very simple Social Security taxable portion approximation.
 * High income → 85% taxable, moderate → 50%, low → 0%.
 */
export function estimateTaxableSocialSecurity(ssAnnual, otherIncome, filingStatus = "married") {
    if (ssAnnual === 0) return 0;

    const provisional = otherIncome + 0.5 * ssAnnual;

    // Rough thresholds; real rules are more complex, but this is directionally correct.
    const midThreshold = filingStatus === "single" ? 25000 : 32000;
    const highThreshold = filingStatus === "single" ? 34000 : 44000;

    if (provisional >= highThreshold) return 0.85 * ssAnnual;
    if (provisional >= midThreshold) return 0.50 * ssAnnual;
    return 0;
}

/**
 * Project a balance forward in years at a given rate.
 */
export function projectBalance(balance, years, rate) {
    return balance * Math.pow(1 + rate, years);
}

/**
 * Very simplified Social Security benefit adjustment for claiming age.
 * We assume ssStatementAnnual is the benefit at FRA (67) and adjust up/down.
 */
export function adjustSSForClaimAge(ssStatementAnnual, claimAge, fraAge = 67) {
    if (!ssStatementAnnual) return 0;

    if (claimAge < fraAge) {
        const monthsEarly = (fraAge - claimAge) * 12;
        const reduction = monthsEarly <= 36
            ? monthsEarly * (5 / 9) / 100
            : (36 * (5 / 9) + (monthsEarly - 36) * (5 / 12)) / 100;
        return ssStatementAnnual * (1 - reduction);
    }

    if (claimAge > fraAge) {
        const monthsDelayed = (claimAge - fraAge) * 12;
        const increase = monthsDelayed * (2 / 3) / 100;
        return ssStatementAnnual * (1 + increase);
    }

    return ssStatementAnnual;
}

/**
 * Core: estimate retirement tax rate at RMD age.
 *
 * Inputs:
 * - currentTrad: current traditional balance
 * - yearsToRetirement: years until retirement
 * - yearsFromRetirementToRMD: years between retirement and 73
 * - growth: annual growth rate (decimal)
 * - ssAnnual: SSA statement estimate at FRA (we adjust for claimAge)
 * - claimAge: age when SS is claimed (62, 67, 70)
 * - filingStatus: "single" | "married"
 * - spendingNeed: optional annual spending target at RMD age
 */
export function estimateRetirementTaxRate({
    currentTrad,
    yearsToRetirement,
    yearsFromRetirementToRMD,
    growth,
    ssAnnual,
    claimAge = 67,
    filingStatus = "married",
    spendingNeed = 0
}) {
    // 1) Project traditional balance to retirement
    const tradAtRetirement = projectBalance(currentTrad, yearsToRetirement, growth);

    // 2) Project to RMD age (73)
    const tradAt73 = projectBalance(tradAtRetirement, yearsFromRetirementToRMD, growth);

    // 3) Compute RMD
    const rmd = estimateRMDAt73(tradAt73);

    // 4) Adjust Social Security for claiming age
    const ssAtClaimAge = adjustSSForClaimAge(ssAnnual, claimAge);

    // 5) Determine if additional withdrawals are needed to meet spending
    let otherWithdrawals = 0;
    if (spendingNeed > 0 && rmd < spendingNeed) {
        otherWithdrawals = spendingNeed - rmd;
    }

    // 6) Estimate taxable Social Security
    const taxableSS = estimateTaxableSocialSecurity(ssAtClaimAge, rmd + otherWithdrawals, filingStatus);

    // 7) Compute taxable income
    const grossIncome = rmd + otherWithdrawals + taxableSS;
    const deduction = STANDARD_DEDUCTION[filingStatus] || STANDARD_DEDUCTION.married;
    const taxableIncome = Math.max(0, grossIncome - deduction);

    // 8) Map to marginal tax rate
    const rate = taxRateForIncome(taxableIncome, filingStatus);

    return {
        tradAtRetirement: Finance.round(tradAtRetirement),
        tradAt73: Finance.round(tradAt73),
        rmd: Finance.round(rmd),
        ssAtClaimAge: Finance.round(ssAtClaimAge),
        taxableSS: Finance.round(taxableSS),
        otherWithdrawals: Finance.round(otherWithdrawals),
        grossIncome: Finance.round(grossIncome),
        taxableIncome: Finance.round(taxableIncome),
        filingStatus,
        estimatedRate: rate
    };
}
