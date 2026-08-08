// The circuit-breaker's pure decision: degrade ALL online traffic once today's estimated neuron spend
// crosses a safety line well below the free 10k/day ceiling -- turning a hard mid-day cutoff into a
// predictable graceful degrade. Best-effort UX, not the $0 guarantee (that is the no-payment account).
export const DAILY_NEURON_BUDGET = 10_000; // Workers AI free tier; resets 00:00 UTC
export const DEGRADE_AT = 0.65; // pre-emptive -- leave headroom below the hard cutoff

export function shouldDegrade(spentToday: number): boolean {
	return spentToday >= DAILY_NEURON_BUDGET * DEGRADE_AT;
}
