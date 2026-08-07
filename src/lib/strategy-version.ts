/**
 * Strategy era version — bump ONLY when picking behavior changes: gates,
 * scoring, calibration, grading. UI, infra, and data-quality fixes do not
 * bump it. Every pick is stamped `${STRATEGY_VERSION}+${buildCommit}`, so
 * audits GROUP BY era while keeping the exact code SHA for forensics.
 *
 * On bump: add a row to docs/STRATEGY.md and tag the commit
 * (`git tag strategy-vN`).
 */
export const STRATEGY_VERSION = "v7-period-prop-gate";
