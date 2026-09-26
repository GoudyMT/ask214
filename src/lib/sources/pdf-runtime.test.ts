import { afterEach, describe, it, expect } from 'vitest';
import { loadPdfRuntime, resetPdfRuntimeForTest } from './pdf-runtime';

// The library is imported by its served URL, which cannot load under test - the same rejection a dropped
// connection produces on a device. A failed load must not be kept: every later document would otherwise open
// as text for the rest of the session, even once the connection is back or the library has been saved.
describe('loadPdfRuntime', () => {
	afterEach(() => {
		resetPdfRuntimeForTest();
	});

	it('tries again after a failed load instead of keeping the failure', async () => {
		const first = loadPdfRuntime();
		await expect(first).rejects.toThrow();
		const second = loadPdfRuntime();
		expect(second).not.toBe(first);
		await expect(second).rejects.toThrow();
	});

	it('shares one load between callers while it is in flight', async () => {
		const first = loadPdfRuntime();
		expect(loadPdfRuntime()).toBe(first);
		await expect(first).rejects.toThrow();
	});
});
