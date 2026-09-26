import { render } from 'vitest-browser-svelte';
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import DocumentsPage from './+page.svelte';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { CORPUS_BASE } from '$lib/ask/corpus-load';
import { saveDocument, savesSettled, stopSaves } from '$lib/sources/document-cache';
import { LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';
import { LIBRARY_SRC, WORKER_SRC } from '$lib/sources/pdf-library-paths';
import { SOURCES_INDEX } from '$lib/sources/sources-index.data';

// Integration: the real generated maps flow through the page, and the page reads the real Cache API. The
// cache is emptied first, so each case starts on a device that has saved nothing.
const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
// A row's Save while its save runs: marked unavailable, not disabled, so it keeps focus.
const unavailable = (el: Element | undefined) => el?.getAttribute('aria-disabled') === 'true';
const SERVED = Object.keys(LOCAL_DOCUMENTS).length;
// What a save stores with its first document - the PDF library and the answer library. A test that saves holds
// them first, so its saves download only the document; the library steps have their own tests.
const LIBRARIES = [LIBRARY_SRC, WORKER_SRC, `${CORPUS_BASE}.json`, `${CORPUS_BASE}.embeddings.bin`];

// The reader loads its page view, pager and Save lazily. Loaded once here, each test renders against loaded
// modules, as the app does after a first open; a cold load under a busy full run can outlast a wait below.
beforeAll(async () => {
	await import('$lib/components/reader-parts');
});

beforeEach(async () => {
	await caches.delete(ASK_ASSET_CACHE);
});

// A held download is let through and waited out even when its test fails, so no save outlives its test.
let release = () => {};
afterEach(async () => {
	release();
	await savesSettled();
	vi.restoreAllMocks();
});

/**
 * Holds the download of `path` until `open` is called, so a test fixes where a save is rather than racing a
 * real download; every other request goes to the network. A save reads the page's fetch on each call, so the
 * page's saves meet the hold.
 */
function holdDownload(path: string) {
	let open = () => {};
	const gate = new Promise<void>((resolve) => (open = resolve));
	release = open;
	const realFetch = globalThis.fetch;
	const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		if (input !== path) return realFetch(input, init);
		await gate;
		return new Response('pdf', { status: 200 });
	});
	return { open, requests: () => spy.mock.calls.filter(([input]) => input === path).length };
}

describe('Documents page', () => {
	it('is headed Documents and says what the page is for', () => {
		const { container } = render(DocumentsPage);
		expect(text(container.querySelector('h1') as Element)).toBe('Documents');
		expect(text(container)).toContain(
			"The official guides behind Ask 214's answers. Open one to read it whole; save it to read it without a connection."
		);
	});

	it('lists every served document, none saved on a device that has saved nothing', async () => {
		const { container } = render(DocumentsPage);
		await vi.waitFor(() =>
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`)
		);
		expect(container.querySelectorAll('li')).toHaveLength(SERVED);
		expect(text(container)).toContain('TAP - Vet Centers (Resource Guide)');
	});

	it('shows a document it finds in the cache as saved', async () => {
		const vet = LOCAL_DOCUMENTS['tap_vet_centers'] ?? '';
		await (await caches.open(ASK_ASSET_CACHE)).put(vet, new Response('pdf'));
		const { container } = render(DocumentsPage);
		await vi.waitFor(() =>
			expect(text(container)).toContain(`1 of ${SERVED} saved on this device - 0.1 MB`)
		);
	});

	// The test server serves static/, so this saves the real 0.1 MB file through the Cache API. The PDF library a
	// first save also stores is held already, so the save downloads only the document; the library step has its
	// own tests, and the source-document E2E saves it for real.
	it('saves a document from its row, then removes it', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const { container } = render(DocumentsPage);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;
		const act = (label: string) =>
			[...vetRow().querySelectorAll('button')].find((b) => text(b) === label);

		await vi.waitFor(() => expect(act('Save')).toBeDefined());
		act('Save')?.click();
		await vi.waitFor(() =>
			expect(text(container)).toContain(`1 of ${SERVED} saved on this device - 0.1 MB`)
		);
		const held = await (
			await caches.open(ASK_ASSET_CACHE)
		).match(LOCAL_DOCUMENTS['tap_vet_centers'] ?? '');
		expect((await held?.arrayBuffer())?.byteLength).toBe(103_411);

		act('Remove')?.click();
		await vi.waitFor(() =>
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`)
		);
	});

	it('removes every held document, older copies included, once the user confirms', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		const held = [
			LOCAL_DOCUMENTS['tap_vet_centers'] ?? '',
			'/docs/tap_vet_centers.0badc0de.pdf',
			LOCAL_DOCUMENTS['tap_va101'] ?? ''
		];
		for (const path of held) await cache.put(path, new Response('pdf'));
		await cache.put('/corpus/corpus-v1.0.2.json', new Response('{}'));
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);

		await vi.waitFor(() =>
			expect(text(container)).toContain(`2 of ${SERVED} saved on this device`)
		);
		button(container, 'Remove all saved documents')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		await vi.waitFor(() =>
			expect(button(dialog, 'Remove 2 documents and 1 older copy')).toBeDefined()
		);
		button(dialog, 'Remove 2 documents and 1 older copy')?.click();

		await vi.waitFor(() =>
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`)
		);
		const left = (await cache.keys()).map((request) => new URL(request.url).pathname);
		expect(left).toEqual(['/corpus/corpus-v1.0.2.json']);
	});

	// An update left the older copy of a document that is not saved again. The page reads its size from the
	// device, counts it, and removes it from its row.
	it('counts an older copy by its stored size, and removes it from its row', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put('/docs/tap_vet_centers.0badc0de.pdf', new Response(new Uint8Array(250_000)));
		const { container } = render(DocumentsPage);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;

		await vi.waitFor(() =>
			expect(text(container)).toContain(
				`0 of ${SERVED} saved on this device - 0.0 MB, plus 1 older copy (0.3 MB)`
			)
		);
		[...vetRow().querySelectorAll('button')].find((b) => text(b) === 'Remove')?.click();

		await vi.waitFor(() => expect(text(container)).not.toContain('older copy'));
		const left = (await cache.keys()).map((request) => new URL(request.url).pathname);
		expect(left).toEqual([]);
	});

	// The device will not give the older copy's size, so it is counted without one and what Remove all frees is
	// not stated, rather than shown as 0.0 MB.
	it('counts an older copy whose size cannot be read without a size', async () => {
		const old = '/docs/tap_vet_centers.0badc0de.pdf';
		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put(old, new Response(new Uint8Array(250_000)));
		const realMatch = Cache.prototype.match;
		vi.spyOn(Cache.prototype, 'match').mockImplementation(function (
			this: Cache,
			request: RequestInfo | URL,
			options?: CacheQueryOptions
		) {
			if (String(request) === old) return Promise.reject(new DOMException('E_TEST_READ'));
			return realMatch.call(this, request, options);
		});
		const { container } = render(DocumentsPage);

		await vi.waitFor(() =>
			expect(text(container.querySelector('.docs-sum__count') as Element)).toBe(
				`0 of ${SERVED} saved on this device - 0.0 MB, plus 1 older copy`
			)
		);
		expect(text(container.querySelector('.docs-hint') as Element)).toBe(
			'The search model, the answer library and your data stay.'
		);
	});

	// The hold ignores the stop, as a download that has arrived does, so the row's save still stores the new
	// version: Remove must wait for it, or the save puts the document straight back after the remove. A Remove
	// that does not wait has finished within a moment; the hold opens only after one.
	it("removing an updated row stops that row's own save first", async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		await cache.put('/docs/tap_vet_centers.0badc0de.pdf', new Response('old'));
		const download = holdDownload(LOCAL_DOCUMENTS['tap_vet_centers'] ?? '');
		const { container } = render(DocumentsPage);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;
		const act = (label: string) =>
			[...vetRow().querySelectorAll('button')].find((b) => text(b) === label);

		await vi.waitFor(() => expect(act('Save again')).toBeDefined());
		act('Save again')?.click();
		await vi.waitFor(() => expect(download.requests()).toBe(1));
		act('Remove')?.click();
		await new Promise((resolve) => setTimeout(resolve, 300));
		download.open();
		await savesSettled();

		await vi.waitFor(async () => {
			const left = (await cache.keys())
				.map((request) => new URL(request.url).pathname)
				.filter((path) => path.startsWith('/docs/'));
			expect(left).toEqual([]);
		});
	});

	// Every document but the smallest is already held, and so is the PDF library a save stores with its first
	// document, so the run makes one real 0.1 MB download. The library step has its own tests.
	it('saves the rest after the user confirms, and shows each one landing', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const [sourceId, path] of Object.entries(LOCAL_DOCUMENTS)) {
			if (sourceId !== 'tap_vet_centers') await cache.put(path, new Response('pdf'));
		}
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);

		await vi.waitFor(() => expect(button(container, 'Save 1 remaining (0.1 MB)')).toBeDefined());
		button(container, 'Save 1 remaining (0.1 MB)')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		button(dialog, 'Save 1 document')?.click();

		await vi.waitFor(() =>
			expect(text(container)).toContain(`${SERVED} of ${SERVED} saved on this device`)
		);
	});

	// This hold ignores the stop, as a download that has already arrived does - it is stored however its save is
	// stopped - so Remove all waits for the save and removes what the cache holds after it.
	it('remove all also removes a document still being saved', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		await cache.put(LOCAL_DOCUMENTS['tap_va101'] ?? '', new Response('pdf'));
		const download = holdDownload(LOCAL_DOCUMENTS['tap_vet_centers'] ?? '');
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;

		await vi.waitFor(() => expect(button(vetRow(), 'Save')).toBeDefined());
		button(vetRow(), 'Save')?.click();
		await vi.waitFor(() => expect(download.requests()).toBe(1));
		button(container, 'Remove all saved documents')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		button(dialog, 'Remove 1 document')?.click();
		download.open();

		// The row's own save has ended once its Save is offered again.
		await vi.waitFor(() => {
			expect(button(vetRow(), 'Save')).toBeDefined();
			expect(unavailable(button(vetRow(), 'Save'))).toBe(false);
		});
		await vi.waitFor(() =>
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`)
		);
		const left = (await cache.keys())
			.map((request) => new URL(request.url).pathname)
			.filter((path) => path.startsWith('/docs/'));
		expect(left).toEqual([]);
	});

	// Remove all stops a Save all run and removes what it saved, so the line saying why the run stopped goes too.
	// Every document but one is held, and that one's download never arrives until it is stopped.
	it('clears the line saying a Save all run stopped, once Remove all has stopped it', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const [sourceId, path] of Object.entries(LOCAL_DOCUMENTS)) {
			if (sourceId !== 'tap_vet_centers') await cache.put(path, new Response('pdf'));
		}
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const vet = LOCAL_DOCUMENTS['tap_vet_centers'] ?? '';
		const realFetch = globalThis.fetch;
		const stalled = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			if (input !== vet) return realFetch(input, init);
			return new Promise<Response>((_resolve, reject) => {
				const stop = () => reject(new DOMException('stopped', 'AbortError'));
				if (init?.signal?.aborted) stop();
				else init?.signal?.addEventListener('abort', stop);
			});
		});
		release = () => void stopSaves();
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);

		await vi.waitFor(() => expect(button(container, 'Save 1 remaining (0.1 MB)')).toBeDefined());
		button(container, 'Save 1 remaining (0.1 MB)')?.click();
		button(container.querySelector('dialog[open]') as Element, 'Save 1 document')?.click();
		await vi.waitFor(() => expect(text(container)).toContain('Saving 0 of 1'));
		expect(stalled.mock.calls.filter(([input]) => input === vet)).toHaveLength(1);

		button(container, 'Remove all saved documents')?.click();
		button(
			container.querySelector('dialog[open]') as Element,
			`Remove ${SERVED - 1} documents`
		)?.click();
		await vi.waitFor(() => {
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`);
			expect(text(container)).not.toContain('Stopped');
		});
	});

	// The WRITE is held here, not the download: a download that has arrived is stored however its save is
	// stopped, so Remove all must wait for that write before it lists what to remove. A Remove all that lists at
	// once does so within a moment; the hold opens only after one, so a Remove all that did not wait has already
	// listed the cache without the document by then.
	it('remove all waits for a write still landing before it lists what to remove', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		await cache.put(LOCAL_DOCUMENTS['tap_va101'] ?? '', new Response('pdf'));
		const vet = LOCAL_DOCUMENTS['tap_vet_centers'] ?? '';
		let open = () => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		release = open;
		let writing = false;
		const realPut = Cache.prototype.put;
		vi.spyOn(Cache.prototype, 'put').mockImplementation(async function (
			this: Cache,
			request: RequestInfo | URL,
			response: Response
		) {
			if (String(request).endsWith(vet)) {
				writing = true;
				await gate;
			}
			return realPut.call(this, request, response);
		});
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;

		await vi.waitFor(() => expect(button(vetRow(), 'Save')).toBeDefined());
		button(vetRow(), 'Save')?.click();
		await vi.waitFor(() => expect(writing).toBe(true));
		button(container, 'Remove all saved documents')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		button(dialog, 'Remove 1 document')?.click();
		await new Promise((resolve) => setTimeout(resolve, 300));
		open();

		await vi.waitFor(async () => {
			const left = (await cache.keys())
				.map((request) => new URL(request.url).pathname)
				.filter((path) => path.startsWith('/docs/'));
			expect(left).toEqual([]);
			expect(text(container)).toContain(`0 of ${SERVED} saved on this device - 0.0 MB`);
		});
		await savesSettled();
		const left = (await cache.keys())
			.map((request) => new URL(request.url).pathname)
			.filter((path) => path.startsWith('/docs/'));
		expect(left).toEqual([]);
	});

	// Every document but two is held, with the PDF library, so the run makes one real 0.2 MB download while
	// the other document's own save is held.
	it('a row being saved is left out of Save all', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const [sourceId, path] of Object.entries(LOCAL_DOCUMENTS)) {
			if (sourceId !== 'tap_vet_centers' && sourceId !== 'tap_va_home_loan') {
				await cache.put(path, new Response('pdf'));
			}
		}
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const download = holdDownload(LOCAL_DOCUMENTS['tap_vet_centers'] ?? '');
		const { container } = render(DocumentsPage);
		const button = (root: Element, label: string) =>
			[...root.querySelectorAll('button')].find((b) => text(b) === label);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;

		await vi.waitFor(() => expect(button(vetRow(), 'Save')).toBeDefined());
		button(vetRow(), 'Save')?.click();
		await vi.waitFor(() => expect(download.requests()).toBe(1));
		await vi.waitFor(() => expect(button(container, 'Save 1 remaining (0.2 MB)')).toBeDefined());
		button(container, 'Save 1 remaining (0.2 MB)')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		button(dialog, 'Save 1 document')?.click();

		// The run has ended once the other document is saved and no progress shows.
		await vi.waitFor(() => {
			expect(text(container)).toContain(`${SERVED - 1} of ${SERVED} saved on this device`);
			expect(text(container)).not.toContain('Saving ');
		});
		expect(download.requests()).toBe(1);
		download.open();
		await vi.waitFor(() =>
			expect(text(container)).toContain(`${SERVED} of ${SERVED} saved on this device`)
		);
		expect(download.requests()).toBe(1);
	});

	// A save started in the reader can still be running when the reader closes. Its row shows it running, so it
	// is not offered twice, and the list shows the document saved once the save lands.
	it("shows a reader's save still running after the reader closes, and the document saved once it lands", async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const download = holdDownload(LOCAL_DOCUMENTS['tap_vet_centers'] ?? '');
		const { container } = render(DocumentsPage);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;
		const rowSave = () => [...vetRow().querySelectorAll('button')].find((b) => text(b) === 'Save');

		await vi.waitFor(() => expect(rowSave()).toBeDefined());
		[...vetRow().querySelectorAll('button')]
			.find((b) => text(b) === 'TAP - Vet Centers (Resource Guide)')
			?.click();
		const reader = container.querySelector('dialog.reader') as HTMLDialogElement;
		await vi.waitFor(() => expect(reader.querySelector('.save')).not.toBeNull());
		(reader.querySelector('.save') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(download.requests()).toBe(1));
		(reader.querySelector('.reader__close') as HTMLButtonElement).click();

		await vi.waitFor(() => expect(reader.open).toBe(false));
		await vi.waitFor(() => expect(unavailable(rowSave())).toBe(true));
		download.open();
		await vi.waitFor(() =>
			expect(text(container)).toContain(`1 of ${SERVED} saved on this device - 0.1 MB`)
		);
		expect(download.requests()).toBe(1);
	});

	// A save started before the page opens - in the reader on the Ask page, whose link leads here - is still
	// running on arrival. Its row shows it running, Save all leaves it out, and the list shows the document saved
	// once the save lands, with no second download.
	it('shows a save already running when it opens, and the document saved once it lands', async () => {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const file of LIBRARIES) await cache.put(file, new Response('js'));
		const vet = LOCAL_DOCUMENTS['tap_vet_centers'] ?? '';
		const download = holdDownload(vet);
		void saveDocument(vet, []);
		await vi.waitFor(() => expect(download.requests()).toBe(1));
		const { container } = render(DocumentsPage);
		const vetRow = () =>
			[...container.querySelectorAll('li')].find((li) =>
				li.textContent?.includes('TAP - Vet Centers (Resource Guide)')
			) as Element;
		const rowSave = () => [...vetRow().querySelectorAll('button')].find((b) => text(b) === 'Save');

		await vi.waitFor(() => expect(unavailable(rowSave())).toBe(true));
		expect(
			[...container.querySelectorAll('button')].some((b) =>
				text(b).startsWith(`Save ${SERVED - 1} remaining`)
			)
		).toBe(true);
		download.open();
		await vi.waitFor(() =>
			expect(text(container)).toContain(`1 of ${SERVED} saved on this device - 0.1 MB`)
		);
		expect(download.requests()).toBe(1);
	});

	it('points to the web-page sources on About', () => {
		const { container } = render(DocumentsPage);
		expect(text(container)).toContain(
			`${SOURCES_INDEX.agency.length} more sources are web pages, read on their official sites.`
		);
	});

	it('opens a document whole in the reader from its title', async () => {
		const { container } = render(DocumentsPage);
		const title = () =>
			[...container.querySelectorAll('button')].find(
				(b) => text(b) === 'TAP - Vet Centers (Resource Guide)'
			);
		await vi.waitFor(() => expect(title()).toBeDefined());
		title()?.click();

		const reader = container.querySelector('dialog.reader') as HTMLDialogElement;
		await vi.waitFor(() => expect(reader.open).toBe(true));
		expect(text(reader.querySelector('.reader__title') as Element)).toBe(
			'TAP - Vet Centers (Resource Guide)'
		);
		// Online, the page view opens at once: the page switch is on "Page" and the page view is mounted.
		await vi.waitFor(() => expect(reader.querySelector('.pdf')).not.toBeNull());
		expect(text(reader.querySelector('.seg [aria-pressed="true"]') as Element)).toBe('Page');
	});

	// The connection can drop and return while the page is open; the page follows it.
	it('follows the connection as it drops and returns', async () => {
		const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
		const { container } = render(DocumentsPage);
		const note = () => text(container.querySelector('.docs-sum__note') as Element);
		await vi.waitFor(() => expect(note()).not.toContain('You are offline'));

		onLine.mockReturnValue(false);
		window.dispatchEvent(new Event('offline'));
		await vi.waitFor(() => expect(note()).toContain('You are offline'));

		onLine.mockReturnValue(true);
		window.dispatchEvent(new Event('online'));
		await vi.waitFor(() => expect(note()).not.toContain('You are offline'));
	});

	// Offline, a document not saved opens only as text, and its text comes from the answer library. The page
	// reads the device for it, so the line says the text opens only where it will.
	it('offline, says the text still opens only when the answer library is on this device', async () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		const note = (container: Element) =>
			text(container.querySelector('.docs-sum__note') as Element);

		const without = render(DocumentsPage);
		await vi.waitFor(() => expect(note(without.container)).toContain('You are offline'));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(note(without.container)).not.toContain('their text still opens');
		without.unmount();

		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put(`${CORPUS_BASE}.json`, new Response('{}'));
		await cache.put(`${CORPUS_BASE}.embeddings.bin`, new Response('vectors'));
		const held = render(DocumentsPage);
		await vi.waitFor(() => expect(note(held.container)).toContain('but their text still opens.'));
	});

	// Until the device has been read, nothing is said of the answer library. Offline, the note does not promise
	// that the text opens on a device that may not hold it, and it does once the device says the library is here.
	it('offline, promises no text before it has read the device', async () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put(`${CORPUS_BASE}.json`, new Response('{}'));
		await cache.put(`${CORPUS_BASE}.embeddings.bin`, new Response('vectors'));
		let letRead = () => {};
		const reading = new Promise<void>((resolve) => (letRead = resolve));
		const has = caches.has.bind(caches);
		vi.spyOn(caches, 'has').mockImplementation(async (name) => {
			await reading;
			return has(name);
		});
		const { container } = render(DocumentsPage);
		const note = () => text(container.querySelector('.docs-sum__note') as Element);

		await vi.waitFor(() => expect(note()).toContain('You are offline'));
		expect(note()).not.toContain('their text still opens');
		letRead();
		await vi.waitFor(() => expect(note()).toContain('but their text still opens.'));
	});

	// The page reads the device for the page reader and the answer library, so the save-all question names each
	// only while it is missing.
	it('says in the save-all question what the first save also stores, only while it is missing', async () => {
		const question = async (container: Element) => {
			const saveRest = () =>
				[...container.querySelectorAll('button')].find((b) => /^Save \d+ remaining/.test(text(b)));
			await vi.waitFor(() => expect(saveRest()).toBeDefined());
			saveRest()?.click();
			return text(container.querySelector('dialog[open] p') as Element);
		};

		const without = render(DocumentsPage);
		await vi.waitFor(async () =>
			expect(await question(without.container)).toContain(
				'The first save also stores the page reader and the answer library (9.1 MB), once, so their text opens offline too.'
			)
		);
		without.unmount();

		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put(LIBRARY_SRC, new Response('library'));
		await cache.put(WORKER_SRC, new Response('worker'));
		const reader = render(DocumentsPage);
		await vi.waitFor(async () =>
			expect(await question(reader.container)).toContain(
				'The first save also stores the answer library (7.3 MB), once, so their text opens offline too.'
			)
		);
		expect(await question(reader.container)).not.toContain('page reader');
		reader.unmount();

		await cache.put(`${CORPUS_BASE}.json`, new Response('{}'));
		await cache.put(`${CORPUS_BASE}.embeddings.bin`, new Response('vectors'));
		const held = render(DocumentsPage);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await question(held.container)).not.toContain('The first save also stores');
	});

	// Before the device is read, nothing is known to be missing, so the question names nothing it may already hold.
	it('names nothing more in the save-all question before it has read the device', () => {
		const { container } = render(DocumentsPage);
		[...container.querySelectorAll('button')]
			.find((b) => /^Save \d+ remaining/.test(text(b)))
			?.click();
		const body = container.querySelector('dialog[open] p') as Element;
		expect(body).not.toBeNull();
		expect(text(body)).not.toContain('The first save also stores');
	});
});
