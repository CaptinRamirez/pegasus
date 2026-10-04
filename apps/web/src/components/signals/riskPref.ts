export const RISK_KEY = 'pegasus.signals.riskPct';

/** Risk per trade the framework allows: 0.5% for the first three months, 0.75% afterwards (fractions of equity). */
export const RISK_CHOICES = ['0.005', '0.0075'] as const;
export type RiskChoice = (typeof RISK_CHOICES)[number];

export const DEFAULT_RISK: RiskChoice = '0.005';

function isRiskChoice(v: string | null): v is RiskChoice {
  return (RISK_CHOICES as readonly (string | null)[]).includes(v);
}

export function readStoredRiskPct(): RiskChoice {
  try {
    const v = localStorage.getItem(RISK_KEY);
    return isRiskChoice(v) ? v : DEFAULT_RISK;
  } catch {
    return DEFAULT_RISK;
  }
}

export function writeStoredRiskPct(riskPct: RiskChoice): void {
  try {
    localStorage.setItem(RISK_KEY, riskPct);
  } catch {
    // storage unavailable (private mode etc.) – the choice still holds for this session
  }
}
