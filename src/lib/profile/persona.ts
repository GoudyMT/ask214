import type { ProfileV1 } from './types';
import { parseEaosAtRead, daysUntilSeparation, decodeEaos, type EaosString } from './eaos';

/**
 * Persona is a discriminated union on `completeness`; consumers MUST narrow before
 * reading optional fields (TS-strict enforces it). Pure + deterministic given `today`.
 *
 * Source: Phase 2 spec section 9 "Persona Derivation".
 */
/**
 * SkillBridge approval (TL-10). Surfaced on the persona only when the profile has the
 * approval flag set AND a positive duration; generation left-shifts military-track tasks
 * by `durationDays` so their deadlines precede leaving for the civilian employer.
 */
export type SkillBridge = { approved: boolean; durationDays: number };

export type PersonaFilters =
	| { completeness: 'none' }
	| {
			completeness: 'eaos-only';
			eaos: EaosString;
			daysUntilSeparation: number;
			skillbridge?: SkillBridge;
	  }
	| {
			completeness: 'partial';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate?: string;
			rank?: string;
			skillbridge?: SkillBridge;
	  }
	| {
			completeness: 'complete';
			eaos: EaosString;
			daysUntilSeparation: number;
			rate: string;
			rank: string;
			familyStatus: string;
			intendedPath: string;
			skillbridge?: SkillBridge;
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

	// SkillBridge surfaces only when explicitly approved with a positive duration; an
	// unset/zero flag or missing duration means no shift (TL-10).
	const skillbridge: SkillBridge | undefined =
		profile.skillbridgeApproved === 1 &&
		typeof profile.skillbridgeDurationDays === 'number' &&
		profile.skillbridgeDurationDays > 0
			? { approved: true, durationDays: profile.skillbridgeDurationDays }
			: undefined;

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
			intendedPath,
			...(skillbridge && { skillbridge })
		};
	}
	if (rate || rank || familyStatus || intendedPath) {
		return {
			completeness: 'partial',
			eaos,
			daysUntilSeparation: dus,
			rate,
			rank,
			...(skillbridge && { skillbridge })
		};
	}
	return {
		completeness: 'eaos-only',
		eaos,
		daysUntilSeparation: dus,
		...(skillbridge && { skillbridge })
	};
}
