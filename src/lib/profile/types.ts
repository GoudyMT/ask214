export type SetupIntent = 'pending' | 'completed';

/**
 * ProfileV1 - canonical type for the stored user profile.
 *
 * TYPE CONSTRAINT (Spec section 5): every field is one of
 * `Uint8Array | Uint8Array[] | number | null | undefined`. No nested objects,
 * no plain strings - so zeroizeField() reaches all PII bytes on relock.
 *
 * Source: Phase 2 spec section 5 "Profile record layout".
 */
export type ProfileV1 = {
	schemaVersion: 1;
	generation: number;
	lastSeenAt: number;
	setupIntent: SetupIntent;
	setupIntentChangedAt: number | null;
	eaos: Uint8Array | null;
	rate?: Uint8Array;
	rank?: Uint8Array;
	yearsOfService?: number;
	anticipatedDisabilityRating?: number;
	familyStatus?: Uint8Array;
	intendedPath?: Uint8Array;
	geographicDestination?: Uint8Array;
	specialSituations?: Uint8Array[];
};
