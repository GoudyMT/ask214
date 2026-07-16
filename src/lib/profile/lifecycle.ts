/**
 * What a relock left behind, in ascending severity.
 *
 * `evicted` and `locked` look identical in memory - the plaintext is gone either way - and that is
 * exactly the problem this type exists to fix. They differ only in whether an automatic re-read may
 * undo them, and nothing about the absent plaintext can answer that. `evicted` is hygiene the app
 * did to itself when the page went away; bringing the page back may undo it. `locked` means the
 * user asked, or their presence lapsed; undoing that silently reverses their intent.
 */
export type LockState = 'unlocked' | 'evicted' | 'locked';

/**
 * Why a relock is happening, declared by whoever triggers it. A store cannot know this - it sees
 * only that its plaintext must go - so the caller passes it down.
 */
export type RelockReason = 'hygiene' | 'idle' | 'user' | 'peer';

const SEVERITY: Record<LockState, number> = { unlocked: 0, evicted: 1, locked: 2 };

/**
 * The state a relock for `reason` lands in. Severity only ever climbs; nothing but a user-initiated
 * load walks it back down.
 *
 * That one-way rule is load-bearing twice over. `pagehide` fires after an explicit Lock too, so a
 * hygiene relock that could rewrite `locked` back to `evicted` would hand the next page restore
 * permission to undo the Lock the user asked for. And `pagehide` and `freeze` both land here with
 * an order that is not consistent across browsers, so a second relock of the same kind has to be a
 * no-op rather than a state change.
 *
 * Args:
 *   current: the state this store is already in.
 *   reason: why it is being relocked now.
 *
 * Returns:
 *   The more severe of the current state and the one `reason` implies.
 */
export function nextLockState(current: LockState, reason: RelockReason): LockState {
	const target: LockState = reason === 'hygiene' ? 'evicted' : 'locked';
	return SEVERITY[target] > SEVERITY[current] ? target : current;
}

/**
 * Recursive zeroization for ProfileV1 field types.
 *
 * ProfileV1 field type constraint (enforced by TypeScript): every field is
 * `Uint8Array | Uint8Array[] | number | null | undefined`. This helper handles
 * the two byte-bearing variants; primitives need no zeroization.
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
 */
export function freezeRelock(profile: Record<string, unknown>): void {
	for (const value of Object.values(profile)) {
		zeroizeField(value);
	}
	scrubSecureInputs();
}
