import { describe, it, expect } from 'vitest';
import { dataPath } from './contract/places';
import { MAX_DAYS_AHEAD, fetchIndex, type FetchFn } from './fetch/fetch-files';
import { MAX_FUTURE_DAYS } from './state/pack-store.svelte';

// Two places refuse a week dated too far ahead: the download (fetchIndex) and the on-device store (a swap, and a held
// index). They must stop at the same day, or a week one accepts the other would throw away. Each keeps its own copy of
// the number, so this is where they are held together.

// Late in the UTC day, so a day counted from the clock's own hour would be a day out.
const DEVICE_NOW = Date.UTC(2026, 9, 22, 23, 59);
const DAY_MS = 86_400_000;
const isoDay = (daysFromDeviceDay: number) =>
	new Date(Date.UTC(2026, 9, 22) + daysFromDeviceDay * DAY_MS).toISOString().slice(0, 10);

const indexOf = (pullDate: string) => ({
	v: 1,
	pullDate,
	baseline: false,
	baselineDate: '2026-10-01',
	files: [{ name: 'pacific', count: 1, bytes: 100 }]
});

const serving = (pullDate: string): FetchFn => {
	const body = JSON.stringify(indexOf(pullDate));
	return (url) =>
		Promise.resolve(
			url === dataPath({ kind: 'index' }) ? new Response(body) : new Response('', { status: 404 })
		);
};

describe('the far-ahead limit on a finder week', () => {
	it('is the same 7 days in the download and in the store', () => {
		expect([MAX_DAYS_AHEAD, MAX_FUTURE_DAYS]).toEqual([7, 7]);
	});

	// The store's own edge (a swap at 7 days kept, at 8 refused) needs a real IndexedDB, so it is held in
	// pack-store.browser.test.ts; this holds the download's edge to the exported number.
	it('lets the download keep an index dated exactly the limit ahead and refuses one a day past it', async () => {
		const at = await fetchIndex(serving(isoDay(MAX_DAYS_AHEAD)), () => DEVICE_NOW);
		expect(at.pullDate).toBe(isoDay(MAX_DAYS_AHEAD));
		await expect(fetchIndex(serving(isoDay(MAX_DAYS_AHEAD + 1)), () => DEVICE_NOW)).rejects.toThrow(
			'E_SBF_INVALID'
		);
	});
});
