// The ladder is terminal and never auto-follows: once BOTH online and on-device have failed this session,
// route straight to the Outbound Link Hub -- never re-offer a failed path (each online hop costs a metered
// inference the free tier caps).
export interface LadderState {
	failed: Set<'online' | 'device'>;
	deviceCapable: boolean;
}

export type Rung = 'offer_device' | 'offer_online' | 'outbound_hub';

/**
 * Pick the next degradation rung from what has already failed this session.
 *
 * @param s Which paths have failed, and whether the device can run on-device retrieval.
 * @returns The next rung; 'outbound_hub' once no in-app path remains.
 */
export function nextRung(s: LadderState): Rung {
	const bothFailed = s.failed.has('online') && s.failed.has('device');
	if (bothFailed) return 'outbound_hub';
	if (s.failed.has('online')) return s.deviceCapable ? 'offer_device' : 'outbound_hub';
	if (s.failed.has('device')) return 'offer_online';
	return 'outbound_hub';
}
