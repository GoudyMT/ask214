import { runningSave, saveDocument, stopCount, type SaveResult } from './document-cache';

/** One document to save: its current path, the older copies to clear once it is stored, and its size. */
export type SaveItem = { path: string; stale: readonly string[]; bytes: number };

/** Why a run ended before its last document. */
export type StoppedBy = 'user' | 'offline' | 'quota' | 'failed';

type SaveFn = (path: string, stale: readonly string[], signal: AbortSignal) => Promise<SaveResult>;

/**
 * Save a list of documents one at a time, with progress the Documents area can show and a way to stop.
 *
 * One at a time, so a stop or a lost connection costs at most the document in progress, and a full disk is
 * met by one save rather than a burst of them. The run ends at the first document that does not save and
 * reports why; everything saved before it stays, and nothing is retried unasked.
 *
 * @param save Saves one document; injected by tests, the real Cache API save by default.
 * @returns The run's state, `start` and `stop`.
 */
export function createSaveAll(
	save: SaveFn = (path, stale, signal) => saveDocument(path, stale, { signal })
) {
	let running = $state(false);
	let done = $state(0);
	let total = $state(0);
	let bytesDone = $state(0);
	let bytesTotal = $state(0);
	let stoppedBy = $state<StoppedBy | null>(null);
	let controller: AbortController | null = null;
	// The run in progress, or the last one, so a stop can wait for it to end.
	let run: Promise<void> = Promise.resolve();

	function start(items: readonly SaveItem[]): Promise<void> {
		if (running) return Promise.resolve();
		run = saveEach(items);
		return run;
	}

	async function saveEach(items: readonly SaveItem[]): Promise<void> {
		running = true;
		controller = new AbortController();
		const { signal } = controller;
		done = 0;
		total = items.length;
		bytesDone = 0;
		bytesTotal = items.reduce((sum, item) => sum + item.bytes, 0);
		stoppedBy = null;
		// Every save stopped from outside the run - clearing the saved documents - ends the run too, including
		// when the save in progress had already arrived and was stored.
		const stopsAtStart = stopCount();
		// A save the run waits on is not its own, so its stop does not reach it: the run ends at the stop instead.
		const stopped = new Promise<SaveResult>((resolve) =>
			signal.addEventListener('abort', () => resolve('stopped'), { once: true })
		);
		for (const item of items) {
			if (signal.aborted || stopCount() !== stopsAtStart) {
				stoppedBy = 'user';
				break;
			}
			// A document's own save already running - from its row or a reader - brings it, so the run waits for
			// that save rather than downloading the document a second time.
			const own = runningSave(item.path);
			const result = own
				? await Promise.race([own, stopped])
				: await save(item.path, item.stale, signal);
			if (result !== 'saved') {
				stoppedBy = result === 'stopped' ? 'user' : result;
				break;
			}
			done += 1;
			bytesDone += item.bytes;
		}
		running = false;
		controller = null;
	}

	return {
		get running() {
			return running;
		},
		get done() {
			return done;
		},
		get total() {
			return total;
		},
		get bytesDone() {
			return bytesDone;
		},
		get bytesTotal() {
			return bytesTotal;
		},
		get stoppedBy() {
			return stoppedBy;
		},
		start,
		/**
		 * Stop the run: the document in progress is abandoned and no other starts. Resolves once the run has
		 * ended, because a document whose download had already arrived is still stored after the abort.
		 */
		async stop(): Promise<void> {
			controller?.abort();
			await run;
		},
		/**
		 * Forget why the last run stopped. Removing every saved document calls this once the run has ended: what
		 * the run saved is gone, so the line saying why it stopped would speak of documents no longer held.
		 */
		clear(): void {
			stoppedBy = null;
		}
	};
}

/**
 * The app's one save-all run. Module-level, so it keeps going while the user moves around the app and the
 * Documents area shows its progress again on return; closing the app ends it.
 */
export const saveAll = createSaveAll();
