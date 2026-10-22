import { describe, expect, it, vi } from 'vitest';
import { DB_VERSION } from '$lib/db/schema';
import { markRaised, takeOverIfRaised } from './take-over';
import { isTakeOver } from './take-over-message';

type Listener = () => void;

function memoryStore(initial?: string) {
	const map = new Map<string, string>(initial === undefined ? [] : [['mtc:db-raised', initial]]);
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k)
	};
}

const storeOf = (mark?: string) => {
	const store = memoryStore(mark);
	return () => store;
};

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

function fakeContainer(waiting: ReturnType<typeof fakeWorker> | null) {
	const onRegistration: Listener[] = [];
	const onContainer: Listener[] = [];
	const registration = {
		waiting,
		installing: null as ReturnType<typeof fakeWorker> | null,
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

describe('the worker of a release that raised the database takes over at once', () => {
	// The release before stays in charge offline and its pages cannot open the raised database.
	it('asks the waiting worker of this build, and looks for one WebKit has not fetched', async () => {
		const worker = fakeWorker();
		const { container, registration } = fakeContainer(worker);
		await takeOverIfRaised(container, 'build-7', storeOf(String(DB_VERSION)));
		expect(worker.postMessage).toHaveBeenCalledWith({ type: 'take-over', build: 'build-7' });
		expect(registration.update).toHaveBeenCalledOnce();
	});

	// The page that raised the database often runs before its worker has finished installing.
	it('asks a worker that finishes installing later', async () => {
		const { container, registration, updateFound } = fakeContainer(null);
		await takeOverIfRaised(container, 'build-7', storeOf(String(DB_VERSION)));
		const late = fakeWorker('installing');
		registration.installing = late;
		updateFound();
		expect(late.postMessage).not.toHaveBeenCalled();
		late.become('installed');
		expect(late.postMessage).toHaveBeenCalledWith({ type: 'take-over', build: 'build-7' });
	});

	// A release that raised nothing keeps the usual wait: open tabs of the release before keep their worker's files.
	it.each([
		['no mark', undefined],
		['the mark of an earlier raise', String(DB_VERSION - 1)]
	])('does nothing with %s', async (_name, mark) => {
		const worker = fakeWorker();
		const { container, registration } = fakeContainer(worker);
		await takeOverIfRaised(container, 'build-7', storeOf(mark));
		expect(worker.postMessage).not.toHaveBeenCalled();
		expect(registration.update).not.toHaveBeenCalled();
	});

	it('drops the mark once a new worker is in charge, and marks only this release', async () => {
		const store = memoryStore();
		markRaised(() => store);
		expect(store.map.get('mtc:db-raised')).toBe(String(DB_VERSION));
		const { container, controllerChange } = fakeContainer(fakeWorker());
		await takeOverIfRaised(container, 'build-7', () => store);
		controllerChange();
		expect(store.map.has('mtc:db-raised')).toBe(false);
	});
});

describe('the worker obeys only a page of its own build', () => {
	// A page of another build must never pull a worker into charge that is not its own.
	it.each([
		[{ type: 'take-over', build: 'build-7' }, true],
		[{ type: 'take-over', build: 'build-6' }, false],
		[{ type: 'skip-waiting', build: 'build-7' }, false],
		[null, false],
		['take-over', false]
	])('%j -> %s', (data, expected) => {
		expect(isTakeOver(data, 'build-7')).toBe(expected);
	});
});
