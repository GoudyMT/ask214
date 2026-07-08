export type SetupIntent = 'pending' | 'completed';

/**
 * ProfileV1 - canonical type for the stored user profile.
 *
 * TYPE CONSTRAINT: every field is one of
 * `Uint8Array | Uint8Array[] | number | null | undefined`. No nested objects,
 * no plain strings - so zeroizeField() reaches all PII bytes on relock.
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
	skillbridgeApproved?: number; // 0/1 SkillBridge-approval flag; flat numeric, not nested, per the zeroizeField field constraint
	skillbridgeDurationDays?: number; // SkillBridge length in days; only meaningful when approved
};
