import type { ProfileV1 } from './types';

/**
 * Canonical profile encoding for AES-GCM input. Uint8Array fields are
 * base64-encoded in transit through JSON and decoded back on read. Top-level
 * keys are sorted so the PLAINTEXT encoding is deterministic for identical
 * inputs (AES-GCM ciphertext is never deterministic - fresh random IV per write).
 *
 * Source: Phase 2 spec section 5; plan v2 T3-A (schemaVersion lives in ciphertext).
 */
export type { ProfileV1 } from './types';

export class ProfileSchemaError extends Error {
	constructor() {
		super('E_PROFILE_SCHEMA');
		this.name = 'ProfileSchemaError';
	}
}

function b64encode(b: Uint8Array): string {
	return btoa(String.fromCharCode(...b));
}

function b64decode(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return out;
}

type WireProfile = {
	schemaVersion: number;
	generation: number;
	lastSeenAt: number;
	setupIntent: string;
	setupIntentChangedAt: number | null;
	eaos: string | null;
	rate?: string;
	rank?: string;
	yearsOfService?: number;
	anticipatedDisabilityRating?: number;
	familyStatus?: string;
	intendedPath?: string;
	geographicDestination?: string;
	specialSituations?: string[];
};

export function encodeProfile(p: ProfileV1): Uint8Array {
	const wire: WireProfile = {
		schemaVersion: p.schemaVersion,
		generation: p.generation,
		lastSeenAt: p.lastSeenAt,
		setupIntent: p.setupIntent,
		setupIntentChangedAt: p.setupIntentChangedAt,
		eaos: p.eaos ? b64encode(p.eaos) : null,
		...(p.rate && { rate: b64encode(p.rate) }),
		...(p.rank && { rank: b64encode(p.rank) }),
		...(p.yearsOfService !== undefined && { yearsOfService: p.yearsOfService }),
		...(p.anticipatedDisabilityRating !== undefined && {
			anticipatedDisabilityRating: p.anticipatedDisabilityRating
		}),
		...(p.familyStatus && { familyStatus: b64encode(p.familyStatus) }),
		...(p.intendedPath && { intendedPath: b64encode(p.intendedPath) }),
		...(p.geographicDestination && {
			geographicDestination: b64encode(p.geographicDestination)
		}),
		...(p.specialSituations && {
			specialSituations: p.specialSituations.map(b64encode)
		})
	};
	const sortedKeys = Object.keys(wire).sort();
	const canon: Record<string, unknown> = {};
	for (const k of sortedKeys) canon[k] = (wire as Record<string, unknown>)[k];
	return new TextEncoder().encode(JSON.stringify(canon));
}

export function decodeProfile(bytes: Uint8Array): ProfileV1 {
	let wire: WireProfile;
	try {
		wire = JSON.parse(new TextDecoder().decode(bytes)) as WireProfile;
	} catch {
		throw new ProfileSchemaError();
	}
	if (wire.schemaVersion !== 1) throw new ProfileSchemaError();
	return {
		schemaVersion: 1,
		generation: wire.generation,
		lastSeenAt: wire.lastSeenAt,
		setupIntent: wire.setupIntent as ProfileV1['setupIntent'],
		setupIntentChangedAt: wire.setupIntentChangedAt,
		eaos: wire.eaos ? b64decode(wire.eaos) : null,
		...(wire.rate && { rate: b64decode(wire.rate) }),
		...(wire.rank && { rank: b64decode(wire.rank) }),
		...(wire.yearsOfService !== undefined && { yearsOfService: wire.yearsOfService }),
		...(wire.anticipatedDisabilityRating !== undefined && {
			anticipatedDisabilityRating: wire.anticipatedDisabilityRating
		}),
		...(wire.familyStatus && { familyStatus: b64decode(wire.familyStatus) }),
		...(wire.intendedPath && { intendedPath: b64decode(wire.intendedPath) }),
		...(wire.geographicDestination && {
			geographicDestination: b64decode(wire.geographicDestination)
		}),
		...(wire.specialSituations && {
			specialSituations: wire.specialSituations.map(b64decode)
		})
	};
}
