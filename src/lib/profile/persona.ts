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
 * Persona is a discriminated union on `completeness`; consumers MUST narrow before
 * reading optional fields (TS-strict enforces it). Pure + deterministic given `today`.
 */
export type PersonaFilters =
	| { completeness: 'none' }
	| {
			completeness: 'eaos-only';
			eaos: EaosString;
			daysUntilSeparation: number;
			leaving?: LeavingDates;
			separationPath?: SeparationPath;
	  }
	| {
			completeness: 'partial';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate?: string;
			rank?: string;
			leaving?: LeavingDates;
			separationPath?: SeparationPath;
	  }
	| {
			completeness: 'complete';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate: string;
			rank: string;
			familyStatus: string;
			intendedPath: string;
			leaving?: LeavingDates;
			separationPath?: SeparationPath;
	  };

function decode(u8?: Uint8Array | null): string | undefined {
	return u8 ? new TextDecoder().decode(u8) : undefined;
}

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

	const rate = decode(profile.rate);
	const rank = decode(profile.rank);
	const familyStatus = decode(profile.familyStatus);
	const intendedPath = decode(profile.intendedPath);
	// The answer stands on its own, like the leaving dates: it never changes the completeness.
	const separationPath = parseSeparationPath(decode(profile.separationPath));

	if (rate && rank && familyStatus && intendedPath) {
		return {
			completeness: 'complete',
			eaos,
			daysUntilSeparation: dus,
			rate,
			rank,
			familyStatus,
			intendedPath,
			...(hasLeaving && { leaving }),
			...(separationPath && { separationPath })
		};
	}
	if (rate || rank || familyStatus || intendedPath) {
		return {
			completeness: 'partial',
			eaos,
			daysUntilSeparation: dus,
			rate,
			rank,
			...(hasLeaving && { leaving }),
			...(separationPath && { separationPath })
		};
	}
	return {
		completeness: 'eaos-only',
		eaos,
		daysUntilSeparation: dus,
		...(hasLeaving && { leaving }),
		...(separationPath && { separationPath })
	};
}
