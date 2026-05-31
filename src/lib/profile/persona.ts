import type { ProfileV1 } from './types';
import { parseEaosAtRead, daysUntilSeparation, decodeEaos, type EaosString } from './eaos';

/**
 * Persona is a discriminated union on `completeness`; consumers MUST narrow before
 * reading optional fields (TS-strict enforces it). Pure + deterministic given `today`.
 *
 * Source: Phase 2 spec section 9 "Persona Derivation".
 */
export type PersonaFilters =
	| { completeness: 'none' }
	| { completeness: 'eaos-only'; eaos: EaosString; daysUntilSeparation: number }
	| {
			completeness: 'partial';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate?: string;
			rank?: string;
	  }
	| {
			completeness: 'complete';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate: string;
			rank: string;
			familyStatus: string;
			intendedPath: string;
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

	const rate = decode(profile.rate);
	const rank = decode(profile.rank);
	const familyStatus = decode(profile.familyStatus);
	const intendedPath = decode(profile.intendedPath);

	if (rate && rank && familyStatus && intendedPath) {
		return {
			completeness: 'complete',
			eaos,
			daysUntilSeparation: dus,
			rate,
			rank,
			familyStatus,
			intendedPath
		};
	}
	if (rate || rank || familyStatus || intendedPath) {
		return { completeness: 'partial', eaos, daysUntilSeparation: dus, rate, rank };
	}
	return { completeness: 'eaos-only', eaos, daysUntilSeparation: dus };
}
