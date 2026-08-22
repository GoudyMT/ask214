import { describe, it, expect, vi } from 'vitest';
import { requestPersistentStorage, type PersistenceOps } from './persistence';

/** A fully-working fake by default; each test overrides only the op it exercises. */
function fakeOps(over: Partial<PersistenceOps> = {}): PersistenceOps {
	return {
		persisted: vi.fn(async () => false),
		persist: vi.fn(async () => true),
		...over
	};
}

describe('requestPersistentStorage', () => {
	it('returns already and does NOT request when storage is already persistent', async () => {
		// An origin already in persistent mode is out of the eviction path; re-requesting wastes a
		// grant on the engines that surface one, so a true persisted() short-circuits before persist().
		const ops = fakeOps({ persisted: vi.fn(async () => true) });
		await expect(requestPersistentStorage(ops)).resolves.toBe('already');
		expect(ops.persist).not.toHaveBeenCalled();
	});

	it('returns granted when the request is granted', async () => {
		const ops = fakeOps({ persist: vi.fn(async () => true) });
		await expect(requestPersistentStorage(ops)).resolves.toBe('granted');
	});

	it('returns denied when the request is refused', async () => {
		const ops = fakeOps({ persist: vi.fn(async () => false) });
		await expect(requestPersistentStorage(ops)).resolves.toBe('denied');
	});

	it('returns unsupported when the API is absent or non-functional - never throws', async () => {
		// The app exercises the API rather than feature-detecting it (a present API can be
		// non-functional). A persisted() that throws - no navigator.storage on old iOS or in SSR -
		// must degrade to unsupported, not break the app-init sequence this runs inside.
		const ops = fakeOps({
			persisted: vi.fn(async () => {
				throw new Error('navigator.storage is undefined');
			})
		});
		await expect(requestPersistentStorage(ops)).resolves.toBe('unsupported');
	});

	it('swallows a thrown persist() to unsupported - never throws', async () => {
		const ops = fakeOps({
			persist: vi.fn(async () => {
				throw new Error('persist() blew up');
			})
		});
		await expect(requestPersistentStorage(ops)).resolves.toBe('unsupported');
	});
});
