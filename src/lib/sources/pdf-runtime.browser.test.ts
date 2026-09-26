import { describe, it, expect } from 'vitest';
import { LIBRARY_SRC, WORKER_SRC, loadPdfRuntime, resetPdfRuntimeForTest } from './pdf-runtime';

describe('loadPdfRuntime', () => {
	// The library is loaded by URL from its own lazy folder rather than bundled, so no page load and no
	// service-worker install ever fetches it. This proves a real browser loads it from there, and that the
	// folder it and its worker share is named for the release the library reports - the pairing pdf.js
	// requires, established by the library itself rather than by a constant.
	it('loads the vendored library and pairs it with the worker from the same release', async () => {
		resetPdfRuntimeForTest();
		const runtime = (await loadPdfRuntime()) as unknown as {
			getDocument: unknown;
			version: string;
			GlobalWorkerOptions: { workerSrc: string };
		};

		expect(typeof runtime.getDocument).toBe('function');
		expect(runtime.GlobalWorkerOptions.workerSrc).toBe(WORKER_SRC);
		expect(LIBRARY_SRC).toBe(`/pdf-worker/${runtime.version}/pdf.min.mjs`);
		expect(WORKER_SRC).toBe(`/pdf-worker/${runtime.version}/pdf.worker.min.mjs`);
	});
});
