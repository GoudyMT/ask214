import { describe, expect, it, vi } from 'vitest';
import { DB_VERSION } from '../db/schema';
import { markRaised, RAISED_KEY, takeOverIfRaised } from './take-over';
import { isTakeOver } from './take-over-message';

type Listener = () => void;

function memoryStore(initial?: string) {
	const map = new Map<string, string>(initial === undefined ? [] : [[RAISED_KEY, initial]]);
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k)
	};
}

function fakeWorker(state = 'installed') {
	const listeners: Listener[] = [];
	return {
		state,
		postMessage: vi.fn(),
		addEventListener: (_t: string, fn: Listener) => void listeners.push(fn),
		become(next: string) {
			this.state = next;
			for (const fn of listeners) fn();
		}
	};
}

type Worker = ReturnType<typeof fakeWorker>;

function fakeContainer(workers: { waiting?: Worker; installing?: Worker } = {}) {
	const onRegistration: Listener[] = [];
	const onContainer: Listener[] = [];
	const registration = {
		waiting: workers.waiting ?? null,
		installing: workers.installing ?? null,
		update: vi.fn(async () => {}),
		addEventListener: (_t: string, fn: Listener) => void onRegistration.push(fn)
	};
	const container = {
		ready: Promise.resolve(registration),
		addEventListener: (_t: string, fn: Listener) => void onContainer.push(fn)
	};
	return {
		registration,
		container: container as unknown as ServiceWorkerContainer,
		updateFound: () => onRegistration.forEach((fn) => fn()),
		controllerChange: () => onContainer.forEach((fn) => fn())
	};
}

const TAKE_OVER_7 = { type: 'take-over', build: 'build-7' };

describe('the worker of a release that raised the database takes over at once', () => {
	// The release before stays in charge offline and its pages cannot open the raised database.
	it('asks the waiting worker of this build, and looks for one WebKit has not fetched', async () => {
		const worker = fakeWorker();
		const { container, registration } = fakeContainer({ waiting: worker });
		const store = memoryStore('build-7');
		await takeOverIfRaised(container, 'build-7', () => store);
		expect(worker.postMessage).toHaveBeenCalledWith(TAKE_OVER_7);
		expect(registration.update).toHaveBeenCalledOnce();
	});

	// The worker of the new release is often still installing when its page raises the database (a missed case left
	// the device on the old worker, failing offline).
	it('asks a worker that is already installing once it has installed', async () => {
		const installing = fakeWorker('installing');
		const { container } = fakeContainer({ installing });
		const store = memoryStore('build-7');
		await takeOverIfRaised(container, 'build-7', () => store);
		expect(installing.postMessage).not.toHaveBeenCalled();
		installing.become('installed');
		expect(installing.postMessage).toHaveBeenCalledWith(TAKE_OVER_7);
	});

	it('asks a worker that starts installing later', async () => {
		const { container, registration, updateFound } = fakeContainer();
		const store = memoryStore('build-7');
		await takeOverIfRaised(container, 'build-7', () => store);
		const late = fakeWorker('installing');
		registration.installing = late;
		updateFound();
		late.become('installed');
		expect(late.postMessage).toHaveBeenCalledWith(TAKE_OVER_7);
	});

	// A release that raised nothing keeps the usual wait: open tabs of the release before keep their worker's files.
	it('does nothing without a mark', async () => {
		const worker = fakeWorker();
		const { container, registration } = fakeContainer({ waiting: worker });
		await takeOverIfRaised(container, 'build-8', () => memoryStore());
		expect(worker.postMessage).not.toHaveBeenCalled();
		expect(registration.update).not.toHaveBeenCalled();
	});

	// A mark can outlive its takeover (the new worker took charge with no page of its build open to see it). The next
	// release, which raised nothing, must not take over because of it - and clears it.
	it('leaves a mark of another build alone and clears it', async () => {
		const worker = fakeWorker();
		const { container, registration } = fakeContainer({ waiting: worker });
		const store = memoryStore('build-7');
		await takeOverIfRaised(container, 'build-8', () => store);
		expect(worker.postMessage).not.toHaveBeenCalled();
		expect(registration.update).not.toHaveBeenCalled();
		expect(store.map.has(RAISED_KEY)).toBe(false);
	});

	// A page of the older release, which its worker still serves offline, clears any mark under the key it knows. A mark it
	// cleared would leave no page of the raising build to ask for the take-over, and the offline banner would stay.
	it('keeps the mark where a page of an older release never looks', () => {
		const store = memoryStore();
		markRaised('build-7', () => store);
		expect(store.map.get(RAISED_KEY)).toBe('build-7');
		expect(store.map.has('mtc:db-raised')).toBe(false);
		// The next raise leans on this too: a fixed key would put this release's pages back in the older pages' place.
		expect(RAISED_KEY).toContain(String(DB_VERSION));
	});

	it('marks the build that raised, and drops the mark once a new worker is in charge', async () => {
		const store = memoryStore();
		markRaised('build-7', () => store);
		expect(store.map.get(RAISED_KEY)).toBe('build-7');
		const { container, controllerChange } = fakeContainer({ waiting: fakeWorker() });
		await takeOverIfRaised(container, 'build-7', () => store);
		expect(store.map.has(RAISED_KEY)).toBe(true);
		controllerChange();
		expect(store.map.has(RAISED_KEY)).toBe(false);
	});
});

describe('the worker obeys only a page of its own build', () => {
	// A page of another build must never pull a worker into charge that is not its own.
	it.each([
		[TAKE_OVER_7, true],
		[{ type: 'take-over', build: 'build-6' }, false],
		[{ type: 'skip-waiting', build: 'build-7' }, false],
		[null, false],
		['take-over', false]
	])('%j -> %s', (data, expected) => {
		expect(isTakeOver(data, 'build-7')).toBe(expected);
	});
});
