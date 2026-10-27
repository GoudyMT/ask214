/**
 * Best-effort cross-tab signal over a raw BroadcastChannel. v1.0
 * carries NO state and NO authentication: the message is an opaque event type, and
 * on receive a tab simply re-reads from IDB (ProfileStore.load, itself fail-closed
 * + verified). A same-origin spoofed signal can at worst trigger a harmless extra
 * re-read - it cannot inject or read state. The authenticated-envelope design
 * (HMAC + replay defense + derived channel name) is deferred to v1.1.
 *
 * A relock may name why it happened (an idle timeout or the user's own Lock). That is not
 * state and decides nothing in a store: it only lets a tab tell a background idle lock
 * from a lock the user chose. A receiver rebuilds the signal from the checked fields, so
 * a spoofed reason or any extra field degrades to a bare signal.
 *
 * BroadcastChannel is intentionally NOT gated by the capability check (multi-tab is
 * best-effort), so its absence degrades to a no-op bus rather than blocking core use.
 */
export type BusSignal = {
	type:
		| 'profile-updated'
		| 'relocked'
		| 'timeline-updated'
		| 'calendar-updated'
		| 'skillbridge-finder-updated'
		| 'data-replaced'
		| 'keys-changed';
	reason?: 'idle' | 'user';
};

export type ProfileBus = {
	publish(signal: BusSignal): void;
	subscribe(handler: (signal: BusSignal) => void): () => void;
	close(): void;
};

const CHANNEL_NAME = 'mtc-profile';

/**
 * Rebuilds a signal from the checked fields only, or null for anything else. The incoming object is
 * never handed on: it may carry extra fields, and a reason other than idle or user is dropped.
 */
function toBusSignal(value: unknown): BusSignal | null {
	if (typeof value !== 'object' || value === null || !('type' in value)) return null;
	const { type, reason } = value as { type: unknown; reason?: unknown };
	if (
		type !== 'profile-updated' &&
		type !== 'relocked' &&
		type !== 'timeline-updated' &&
		type !== 'calendar-updated' &&
		type !== 'skillbridge-finder-updated' &&
		type !== 'data-replaced' &&
		type !== 'keys-changed'
	) {
		return null;
	}
	return reason === 'idle' || reason === 'user' ? { type, reason } : { type };
}

export function createProfileBus(channelName: string = CHANNEL_NAME): ProfileBus {
	if (typeof BroadcastChannel === 'undefined') {
		// Multi-tab is best-effort (the capability gate does not require BroadcastChannel).
		return {
			publish() {
				/* no-op: BroadcastChannel unavailable */
			},
			subscribe() {
				return () => {};
			},
			close() {
				/* no-op */
			}
		};
	}

	const channel = new BroadcastChannel(channelName);
	return {
		publish(signal: BusSignal): void {
			channel.postMessage(signal);
		},
		subscribe(handler: (signal: BusSignal) => void): () => void {
			const listener = (ev: MessageEvent): void => {
				const signal = toBusSignal(ev.data);
				if (signal) handler(signal);
			};
			channel.addEventListener('message', listener);
			return () => channel.removeEventListener('message', listener);
		},
		close(): void {
			channel.close();
		}
	};
}
