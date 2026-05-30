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

/**
 * Deep-copy a single ProfileV1 field value so the result shares no memory with the
 * source. Counterpart to zeroizeField: save() uses it to decouple the staged record
 * from the live _profile, so a concurrent relock's in-place zeroize cannot corrupt it.
 *
 * Args:
 *   v: a ProfileV1 field value (Uint8Array | Uint8Array[] | primitive).
 *
 * Returns:
 *   A fresh deep copy for byte fields; the value unchanged for primitives.
 */
export function cloneField(v: unknown): unknown {
	if (v instanceof Uint8Array) return new Uint8Array(v);
	if (Array.isArray(v)) {
		return v.map((item) => (item instanceof Uint8Array ? new Uint8Array(item) : item));
	}
	return v;
}

/**
 * Registry of sensitive <input> elements to clear on relock. A Set (not a
 * WeakSet) so it is iterable for scrubbing; registration returns an unregister
 * fn the caller invokes on unmount to keep the set leak-free.
 */
const secureInputs = new Set<HTMLInputElement>();

/**
 * Register a sensitive input so its value is wiped on relock.
 *
 * Args:
 *   el: the input element to track.
 *
 * Returns:
 *   An unregister function; call it when the element unmounts.
 */
export function registerSecureInput(el: HTMLInputElement): () => void {
	secureInputs.add(el);
	return () => secureInputs.delete(el);
}

/**
 * Clear the value of every registered input. Scrubs all tracked inputs
 * unconditionally (not isConnected-gated) - a still-referenced detached node can
 * retain cleartext, so it gets wiped too.
 */
export function scrubSecureInputs(): void {
	for (const el of secureInputs) {
		el.value = '';
	}
}

/**
 * Synchronous relock primitive: zeroize every byte-bearing field of the profile
 * in place, then scrub registered DOM inputs. MUST NOT await - this is called from
 * the synchronous pagehide/freeze handlers (wired at app-init). The caller nulls
 * its own profile reference after this returns.
 *
 * Args:
 *   profile: the in-memory profile object whose fields are zeroized in place.
 *
 * Source: Phase 2 spec section 8 ("Relock action") + section 11 ("Memory hygiene").
 */
export function freezeRelock(profile: Record<string, unknown>): void {
	for (const value of Object.values(profile)) {
		zeroizeField(value);
	}
	scrubSecureInputs();
}
