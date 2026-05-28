/**
 * Recursive zeroization for ProfileV1 field types.
 *
 * ProfileV1 field type constraint (enforced by TypeScript): every field is
 * `Uint8Array | Uint8Array[] | number | null | undefined`. This helper handles
 * the two byte-bearing variants; primitives need no zeroization.
 *
 * Source: Phase 2 spec section 8 ("Relock action") + section 11 ("Memory hygiene").
 */
export function zeroizeField(v: unknown): void {
	if (v instanceof Uint8Array) {
		v.fill(0);
		return;
	}
	if (Array.isArray(v)) {
		for (const item of v) {
			if (item instanceof Uint8Array) item.fill(0);
		}
		v.length = 0;
		return;
	}
	// primitives (number | null | undefined | other) require no zeroization
}
