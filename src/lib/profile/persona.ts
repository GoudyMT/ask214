import type { ProfileV1 } from './types';
import { parseEaosAtRead, daysUntilSeparation, decodeEaos, type EaosString } from './eaos';
import { parseSeparationPath, type SeparationPath } from './separation-path';

/**
 * The dates a member leaves the command before separation (ISO). A stored date on or after separation is not used
 * - no one leaves the command after they separate - and is reported under `notUsed` so the Timeline can say so.
 */
export type LeavingDates = {
	skillbridgeStart?: EaosString;
	terminalLeaveStart?: EaosString;
	notUsed?: { skillbridgeStart?: EaosString; terminalLeaveStart?: EaosString };
};

/**
 * Persona is a discriminated union on `completeness`: 'none' until a separation date is stored. Consumers MUST
 * narrow before reading the date (TS-strict enforces it). Pure + deterministic given `today`. Rate, rank, family
 * status and intended path, which an old profile can still hold, are not read: nothing in the app shows from them.
 */
export type PersonaFilters =
	| { completeness: 'none' }
	| {
			completeness: 'eaos-only';
			eaos: EaosString;
			daysUntilSeparation: number;
			leaving?: LeavingDates;
			separationPath?: SeparationPath;
	  };

export function derivePersona(profile: ProfileV1 | null, today = new Date()): PersonaFilters {
	if (!profile?.eaos) return { completeness: 'none' };

	let eaos: EaosString;
	try {
		eaos = parseEaosAtRead(decodeEaos(profile.eaos));
	} catch {
		return { completeness: 'none' };
	}
	const dus = daysUntilSeparation(eaos, today);

	// Each date on its own: a damaged one reads as not set and never touches the EAOS or the completeness.
	const leaving: LeavingDates = {};
	for (const field of ['skillbridgeStart', 'terminalLeaveStart'] as const) {
		const bytes = profile[field];
		if (!bytes) continue;
		let iso: EaosString;
		try {
			iso = parseEaosAtRead(decodeEaos(bytes));
		} catch {
			continue;
		}
		if (iso < eaos) leaving[field] = iso;
		else leaving.notUsed = { ...leaving.notUsed, [field]: iso };
	}
	const hasLeaving = Object.keys(leaving).length > 0;

	// The answer stands on its own, like the leaving dates: it never changes the completeness. It is read with a
	// byte-order mark kept, as the backup reads it, so the timeline never acts on an answer a backup would leave out.
	const separationPath = parseSeparationPath(profile.separationPath);

	return {
		completeness: 'eaos-only',
		eaos,
		daysUntilSeparation: dus,
		...(hasLeaving && { leaving }),
		...(separationPath && { separationPath })
	};
}
