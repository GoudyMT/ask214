import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import { createCalendarSyncStore } from './store.svelte';

// `locked` is what a page reads to tell a calendar that has no read coming from one still loading, so it has to be
// something a page can react to: a plain variable would leave the page showing what it saw first.
describe('calendar store, locked', () => {
	it('re-runs what reads it when the lock comes, and not when only the page is hidden', () => {
		// A relock never touches the database, so a stand-in is enough.
		const store = createCalendarSyncStore({} as IDBDatabase);
		const seen: boolean[] = [];
		const stop = $effect.root(() => {
			const locked = $derived(store.locked);
			$effect(() => {
				seen.push(locked);
			});
		});
		flushSync();
		expect(seen).toEqual([false]);

		store.relockSync('hygiene');
		flushSync();
		expect(seen).toEqual([false]);

		store.relockSync('user');
		flushSync();
		expect(seen).toEqual([false, true]);
		stop();
	});
});
