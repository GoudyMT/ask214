import type { PdfContentItem } from './pdf-text';
import { LIBRARY_SRC, WORKER_SRC } from './pdf-library-paths';

// Re-exported so the release check reads the exact paths this loader loads.
export { LIBRARY_SRC, WORKER_SRC };

/**
 * The slice of the PDF library the reader uses, declared structurally.
 *
 * Two reasons. Nothing in `src/` may import the library statically, types included, so that a passive
 * visit never loads it. And because `loadPdfRuntime` returns this type, the compiler proves the real
 * library satisfies it - so a test's stand-in and the real thing are held to one contract, and a library
 * upgrade that changes this surface fails the type check instead of the reader.
 */
export interface PdfViewport {
	width: number;
	height: number;
	transform: number[];
}

export interface PdfRenderTask {
	promise: Promise<unknown>;
	cancel(): void;
}

export interface PdfPage {
	getViewport(params: { scale: number }): PdfViewport;
	render(params: {
		canvas: HTMLCanvasElement | null;
		viewport: PdfViewport;
		transform?: number[];
	}): PdfRenderTask;
	getTextContent(): Promise<{ items: PdfContentItem[] }>;
	cleanup(): unknown;
}

export interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
}

export interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	destroy(): Promise<void>;
	// Set by the caller; the library calls it with `{ loaded, total }` as the file arrives. Typed `unknown`
	// because the library declares it as a bare `Function`, which no typed callback can be assigned from.
	onProgress?: unknown;
}

export interface PdfRuntime {
	getDocument(source: {
		url: string;
		disableRange?: boolean;
		disableStream?: boolean;
	}): PdfLoadingTask;
}

/**
 * Load the PDF runtime, once, on first use.
 *
 * The library and its worker are together about 1.7 MB, and a reader nobody opens must cost nothing, so
 * BOTH are VENDORED into their own served namespace and fetched only when this runs or a document is saved
 * (a save stores them, so the saved document draws offline) - the same shape the
 * model and the WASM already use, for the same reason. Anything the bundler emits lands under the immutable
 * build namespace, where the service worker precaches it at install: bundling the library - even behind a
 * dynamic import - would have every visitor download it on their first visit, and the install writes its
 * entries as one batch, so a flaky connection on that one file fails the whole install.
 *
 * So the library is imported by URL, which the bundler leaves alone. The cast keeps the compiler's proof
 * that the real library satisfies `PdfRuntime`, from a type-position reference that emits nothing.
 */
let runtime: Promise<PdfRuntime> | null = null;

export function loadPdfRuntime(): Promise<PdfRuntime> {
	if (runtime === null) {
		const library = import(/* @vite-ignore */ LIBRARY_SRC) as Promise<typeof import('pdfjs-dist')>;
		runtime = library.then(
			(pdfjs) => {
				pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
				return pdfjs;
			},
			// A failed load is not kept, so the next document tries again rather than the session staying on text.
			(error: unknown) => {
				runtime = null;
				throw error;
			}
		);
	}
	return runtime;
}

/** Drop the cached runtime so a test can observe a fresh load. Not used by the app. */
export function resetPdfRuntimeForTest(): void {
	runtime = null;
}
