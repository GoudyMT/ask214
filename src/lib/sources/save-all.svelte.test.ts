import { afterEach, describe, it, expect, vi } from 'vitest';
import { createSaveAll, type SaveItem } from './save-all.svelte';
import {
	runningSave,
	saveDocument,
	savesSettled,
	stopSaves,
	type SaveResult
} from './document-cache';

// Three documents of DIFFERENT sizes, so a byte total that counts the wrong ones cannot come out right.
const ITEMS: SaveItem[] = [
	{ path: '/docs/tap_vet_centers.1dcfd966.pdf', stale: [], bytes: 289_929 },
	{ path: '/docs/tap_va101.0f650528.pdf', stale: ['/docs/tap_va101.0badc0de.pdf'], bytes: 386_193 },
	{ path: '/docs/tap_dol_efct.71de2688.pdf', stale: [], bytes: 13_054_075 }
];
const TOTAL_BYTES = 289_929 + 386_193 + 13_054_075;

/** A save that waits until the test settles it, so progress can be read between documents. */
function controlledSave() {
	const calls: { path: string; stale: readonly string[]; signal: AbortSignal }[] = [];
	const pending: ((result: SaveResult) => void)[] = [];
	const save = (path: string, stale: readonly string[], signal: AbortSignal) => {
		calls.push({ path, stale, signal });
		return new Promise<SaveResult>((resolve) => pending.push(resolve));
	};
	const settle = async (result: SaveResult) => {
		pending.shift()?.(result);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { save, calls, settle };
}

describe('createSaveAll', () => {
	it('saves in order, one at a time, counting documents and bytes as each one lands', async () => {
		const { save, calls, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);

		expect(store.running).toBe(true);
		expect(calls.map((c) => c.path)).toEqual([ITEMS[0]?.path]);
		expect([store.done, store.total, store.bytesDone, store.bytesTotal]).toEqual([
			0,
			3,
			0,
			TOTAL_BYTES
		]);

		await settle('saved');
		expect(calls.map((c) => c.path)).toEqual([ITEMS[0]?.path, ITEMS[1]?.path]);
		expect(calls[1]?.stale).toEqual(['/docs/tap_va101.0badc0de.pdf']);
		expect([store.done, store.bytesDone]).toEqual([1, 289_929]);

		await settle('saved');
		await settle('saved');
		await run;
		expect([store.done, store.bytesDone, store.running, store.stoppedBy]).toEqual([
			3,
			TOTAL_BYTES,
			false,
			null
		]);
	});

	it('stops the download in progress and starts no other when the user stops it', async () => {
		const { save, calls, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);

		store.stop();
		expect(calls[0]?.signal.aborted).toBe(true);
		// The save may still finish if its bytes were already in; either way nothing after it starts. Counted
		// before awaiting the run, so a save that wrongly starts fails here instead of hanging the run.
		await settle('saved');
		expect(calls).toHaveLength(1);
		await run;
		expect([store.done, store.running, store.stoppedBy]).toEqual([1, false, 'user']);
	});

	// Clearing the saved documents waits on the stop, so the stop must not resolve while the document in
	// progress can still be stored. An abandoned download settles a tick after its signal aborts.
	it('stop resolves only once the document in progress has stopped', async () => {
		const save = (_path: string, _stale: readonly string[], signal: AbortSignal) =>
			new Promise<SaveResult>((resolve) =>
				signal.addEventListener('abort', () => setTimeout(() => resolve('stopped'), 0))
			);
		const store = createSaveAll(save);
		void store.start(ITEMS);
		expect(store.running).toBe(true);

		await store.stop();
		expect([store.running, store.done, store.stoppedBy]).toEqual([false, 0, 'user']);
	});

	it('reports a stopped save as stopped by the user', async () => {
		const { save, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);
		await settle('saved');
		store.stop();
		await settle('stopped');
		await run;
		expect([store.done, store.stoppedBy]).toEqual([1, 'user']);
	});

	// What is saved stays, and the area says why it stopped; nothing is retried unasked.
	for (const reason of ['offline', 'quota', 'failed'] as const) {
		it(`stops at the first failure and reports why (${reason}), keeping what was saved`, async () => {
			const { save, calls, settle } = controlledSave();
			const store = createSaveAll(save);
			const run = store.start(ITEMS);
			await settle('saved');
			await settle(reason);
			expect(calls).toHaveLength(2);
			await run;
			expect([store.done, store.bytesDone, store.running, store.stoppedBy]).toEqual([
				1,
				289_929,
				false,
				reason
			]);
		});
	}

	it('ignores a second start while one is running', async () => {
		const { save, calls, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS.slice(0, 1));
		void store.start(ITEMS.slice(1));
		expect(store.total).toBe(1);
		await settle('saved');
		await run;
		expect(calls.map((c) => c.path)).toEqual([ITEMS[0]?.path]);
	});

	// Remove all takes what a stopped run saved, so the line saying why it stopped would speak of documents gone.
	it('forgets why the last run stopped when cleared, keeping its count', async () => {
		const { save, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);
		await settle('saved');
		await settle('quota');
		await run;
		expect(store.stoppedBy).toBe('quota');

		store.clear();
		expect([store.stoppedBy, store.running, store.done]).toEqual([null, false, 1]);
	});

	it('starts afresh after a run that stopped', async () => {
		const { save, settle } = controlledSave();
		const store = createSaveAll(save);
		const first = store.start(ITEMS);
		await settle('quota');
		await first;
		expect(store.stoppedBy).toBe('quota');

		const second = store.start(ITEMS.slice(2));
		expect([store.done, store.total, store.bytesTotal, store.stoppedBy]).toEqual([
			0,
			1,
			13_054_075,
			null
		]);
		await settle('saved');
		await second;
		expect([store.done, store.stoppedBy]).toEqual([1, null]);
	});
});

// A document's own save - from its row or a reader - can already be running when a run reaches it. That save
// already brings it, so the run waits for it rather than downloading the document a second time.
describe('a run meeting a document already being saved', () => {
	// A held save is let through and waited out even when its test fails, so none outlives its test.
	let holds: (() => void)[] = [];
	afterEach(async () => {
		for (const open of holds) open();
		holds = [];
		await savesSettled();
	});

	/** A real save of `path` whose download waits until `open` is called. */
	function heldOwnSave(path: string) {
		let open = () => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		holds.push(open);
		const cachesApi = {
			async open() {
				return {
					async match() {
						return undefined;
					},
					async put() {}
				};
			}
		} as unknown as CacheStorage;
		const done = saveDocument(path, [], {
			fetchFn: async () => {
				await gate;
				return new Response('pdf', { status: 200 });
			},
			cachesApi,
			isOnline: () => true,
			library: []
		});
		return { open, done };
	}

	it('waits for that save instead of starting another, and counts it once it lands', async () => {
		const own = heldOwnSave(ITEMS[1]?.path ?? '');
		const { save, calls, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);

		await settle('saved');
		expect(calls.map((c) => c.path)).toEqual([ITEMS[0]?.path]);
		expect([store.done, store.running]).toEqual([1, true]);

		own.open();
		await own.done;
		await vi.waitFor(() =>
			expect(calls.map((c) => c.path)).toEqual([ITEMS[0]?.path, ITEMS[2]?.path])
		);
		await settle('saved');
		await run;
		expect([store.done, store.bytesDone, store.stoppedBy]).toEqual([3, TOTAL_BYTES, null]);
	});

	// The save it waits on is not the run's own, so stopping the run neither waits for that save nor stops it.
	it('ends at once when stopped while it waits, leaving that save running', async () => {
		const own = heldOwnSave(ITEMS[1]?.path ?? '');
		const { save, settle } = controlledSave();
		const store = createSaveAll(save);
		const run = store.start(ITEMS);
		await settle('saved');

		const outcome = await Promise.race([
			store.stop().then(() => 'ended'),
			new Promise((resolve) => setTimeout(() => resolve('still running'), 300))
		]);
		expect(outcome).toBe('ended');
		await run;
		expect([store.running, store.done, store.stoppedBy]).toEqual([false, 1, 'user']);
		expect(runningSave(ITEMS[1]?.path ?? '')).toBeDefined();

		own.open();
		expect(await own.done).toBe('saved');
	});
});

// Clearing the saved documents stops every save from outside the run - `stopSaves` - rather than through the
// run's own stop, so the run must end by itself at the save stopped under it and start nothing more.
describe('a run whose save is stopped from outside', () => {
	it('ends at the stopped save and requests no other document', async () => {
		const requested: string[] = [];
		const cachesApi = {
			async open() {
				return {
					async match() {
						return undefined;
					},
					async put() {}
				};
			}
		} as unknown as CacheStorage;
		// A download that never arrives. Like the browser's fetch, it rejects at once on a signal already
		// stopped, and otherwise when the signal stops.
		const stalled = (path: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				requested.push(path);
				const stop = () => reject(new DOMException('stopped', 'AbortError'));
				if (init?.signal?.aborted) stop();
				else init?.signal?.addEventListener('abort', stop);
			});
		const store = createSaveAll((path, stale, signal) =>
			saveDocument(path, stale, {
				signal,
				fetchFn: stalled,
				cachesApi,
				isOnline: () => true,
				library: []
			})
		);

		const run = store.start(ITEMS);
		await vi.waitFor(() => expect(requested).toHaveLength(1));
		const outcome = await Promise.race([
			stopSaves().then(() => run.then(() => 'ended')),
			new Promise((resolve) => setTimeout(() => resolve('still running'), 300))
		]);

		expect(outcome).toBe('ended');
		expect([store.running, store.done, store.stoppedBy]).toEqual([false, 0, 'user']);
		expect(requested).toEqual([ITEMS[0]?.path]);
	});

	// A download that has arrived is stored however its save is stopped, so that save ends as saved. The run
	// must still end there: the stop was for every save, not only the one in progress.
	it('ends at a save whose write lands after the stop, and requests no other document', async () => {
		const requested: string[] = [];
		let open = () => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		let writing = false;
		const cachesApi = {
			async open() {
				return {
					async match() {
						return undefined;
					},
					async put() {
						writing = true;
						await gate;
					}
				};
			}
		} as unknown as CacheStorage;
		const store = createSaveAll((path, stale, signal) =>
			saveDocument(path, stale, {
				signal,
				fetchFn: async (file) => {
					requested.push(file);
					return new Response('pdf', { status: 200 });
				},
				cachesApi,
				isOnline: () => true,
				library: []
			})
		);

		const run = store.start(ITEMS);
		await vi.waitFor(() => expect(writing).toBe(true));
		const stopping = stopSaves();
		open();
		await stopping;
		await run;

		expect(requested).toEqual([ITEMS[0]?.path]);
		expect([store.running, store.done, store.stoppedBy]).toEqual([false, 1, 'user']);
	});
});
