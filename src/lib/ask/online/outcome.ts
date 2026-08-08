// The client maps ONLY status:'empty' to the "no official source covers that" message. Every transport
// failure (throw / timeout / 5xx / a rate-cap response) is service-unavailable -> the degradation ladder,
// never the honest "no source exists" -- reporting a network failure as an authoritative empty answer
// would be silently wrong.
export type RetrieveResult =
	| { status: 'results'; results: unknown[]; corpusVersion: string }
	| { status: 'empty'; corpusVersion?: string }
	| { status: 'high_demand' }
	| { status: 'error' };

export type ClientAction = 'render' | 'no_source' | 'degrade' | 'service_unavailable';

/**
 * Map a retrieve outcome to the single client action it authorizes.
 *
 * @param r The discriminated retrieve result.
 * @returns The client action; only 'empty' yields 'no_source'.
 */
export function mapOutcome(r: RetrieveResult): ClientAction {
	switch (r.status) {
		case 'results':
			return 'render';
		case 'empty':
			return 'no_source';
		case 'high_demand':
			return 'degrade';
		case 'error':
			return 'service_unavailable';
	}
}
