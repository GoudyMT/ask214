/**
 * Best-effort cross-tab signal over a raw BroadcastChannel. v1.0 (plan v2 T1-E)
 * carries NO state and NO authentication: the message is an opaque event type, and
 * on receive a tab simply re-reads from IDB (ProfileStore.load, itself fail-closed
 * + verified). A same-origin spoofed signal can at worst trigger a harmless extra
 * re-read - it cannot inject or read state. The authenticated-envelope design
 * (HMAC + replay defense + derived channel name) is deferred to v1.1 per ADR-012.
 *
 * BroadcastChannel is intentionally NOT gated by the capability check (multi-tab is
 * best-effort), so its absence degrades to a no-op bus rather than blocking core use.
 *
 * Source: plan v2 audit T1-E; ADR-012 (v1.1 authenticated version deferred).
 */
export type BusSignal = { type: 'profile-updated' | 'relocked' };

export type ProfileBus = {
	publish(signal: BusSignal): void;
	subscribe(handler: (signal: BusSignal) => void): () => void;
	close(): void;
};

const CHANNEL_NAME = 'mtc-profile';

function isBusSignal(value: unknown): value is BusSignal {
	if (typeof value !== 'object' || value === null || !('type' in value)) return false;
	const t = (value as { type: unknown }).type;
	return t === 'profile-updated' || t === 'relocked';
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
				if (isBusSignal(ev.data)) handler(ev.data);
			};
			channel.addEventListener('message', listener);
			return () => channel.removeEventListener('message', listener);
		},
		close(): void {
			channel.close();
		}
	};
}
