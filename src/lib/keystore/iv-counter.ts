/**
 * IV counter advance helper for AES-GCM operation:
 * - warn at 2^28 (surface a user-visible prompt to rotate the key)
 * - hard-stop at 2^32 - 2^24 (refuse further writes)
 *
 * The counter lives in KeystoreRecordV1.ivCounter, bumped by profile writes only - the timeline /
 * calendar / byok stores share the data key but do not bump it, so this counts profile saves, not
 * total encryptions under the key. IVs are random per write (NOT counter-derived), so IV-collision
 * safety rests on the ~2^48 birthday bound; this counter is a conservative rotation prompt +
 * defensive stop, not that guarantee. Rotation recovery is v1.1; in v1.0 the hard-stop is
 * effectively unreachable (~4.26 billion profile writes).
 */
export const IV_WARN_THRESHOLD = 2 ** 28;
export const IV_HARD_STOP = 2 ** 32 - 2 ** 24;

export class IvCounterExhaustedError extends Error {
	constructor() {
		super('E_IV_COUNTER_EXHAUSTED');
		this.name = 'IvCounterExhaustedError';
	}
}

export type IvBumpResult = {
	newValue: number;
	warn: boolean;
	halt: boolean;
};

export function bumpIvCounter(prev: number): IvBumpResult {
	if (prev >= IV_HARD_STOP) throw new IvCounterExhaustedError();
	const newValue = prev + 1;
	return {
		newValue,
		warn: newValue >= IV_WARN_THRESHOLD,
		halt: newValue >= IV_HARD_STOP
	};
}
