import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import SourceReader from './SourceReader.svelte';
import type { Source } from '$lib/ask/sources';
import type { PdfDocument, PdfRuntime } from '$lib/sources/pdf-runtime';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { localDocumentPath } from '$lib/sources/local-document';
import { pageInView } from '$lib/sources/scroll-pages';

function source(over: Partial<Source> = {}): Source {
	return {
		sourceId: 'va_intent_to_file',
		title: 'VA - Intent to File',
		url: 'https://www.va.gov/',
		passages: [
			{ id: 's1', text: 'An intent to file lets you tell VA that you plan to file a claim.' },
			{ id: 's2', text: 'Filing one sets a potential effective date for your benefits.' }
		],
		...over
	};
}

describe('SourceReader', () => {
	it('opens as a modal dialog showing the source title and every held passage', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog).not.toBeNull();
		expect(dialog.open).toBe(true); // showModal(), not a non-modal `open` attribute
		expect(container.querySelector('.reader__title')?.textContent).toBe('VA - Intent to File');
		const passages = container.querySelectorAll('.reader__passage');
		expect(passages.length).toBe(2);
		expect(passages[0]?.textContent).toContain('intent to file lets you');
		expect(passages[1]?.textContent).toContain('effective date');
	});

	it('links to the official site safely (new tab, noopener noreferrer)', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		const link = container.querySelector('.reader__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe('https://www.va.gov/');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	});

	// A modal reader holds the page behind it still, so a scroll moves the document, never the page.
	it('locks the page behind it while open, and releases it when closed', async () => {
		const { container, rerender } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		expect(getComputedStyle(document.documentElement).overflow).toBe('hidden');
		const body = container.querySelector('.reader__body') as HTMLElement;
		expect(getComputedStyle(body).overscrollBehaviorY).toBe('contain');

		await rerender({ source: null });
		flushSync();
		expect(getComputedStyle(document.documentElement).overflow).not.toBe('hidden');
	});

	it('the close button fires onClose', () => {
		let closed = 0;
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => closed++ }
		});
		flushSync();
		(container.querySelector('.reader__close') as HTMLButtonElement).click();
		flushSync();
		expect(closed).toBe(1);
	});

	it('renders no dialog content and stays closed when there is no source', () => {
		const { container } = render(SourceReader, { props: { source: null, onClose: () => {} } });
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(false);
		// a closed <dialog> must keep the UA display:none - else the empty box paints a bar in page flow
		expect(getComputedStyle(dialog).display).toBe('none');
		expect(container.querySelector('.reader__title')).toBeNull();
	});

	it('opens in a loading state while the source is being fetched (no silent dead button)', () => {
		const { container } = render(SourceReader, {
			props: { source: null, loading: true, onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true); // the reader opens immediately, giving the click feedback
		expect(container.querySelector('.reader__status')?.textContent).toMatch(/loading/i);
		expect(container.querySelector('.reader__passage')).toBeNull(); // no content yet
	});

	it('opens in an error state when the source cannot be loaded', () => {
		const { container } = render(SourceReader, {
			props: { source: null, error: true, onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		expect(container.querySelector('.reader__status')?.textContent).toMatch(
			/could ?n.?t|try again/i
		);
	});

	it('error: moves focus to the alert message so a screen reader hears the failure', () => {
		const { container } = render(SourceReader, {
			props: { source: null, error: true, onClose: () => {} }
		});
		flushSync();
		const status = container.querySelector('.reader__status') as HTMLElement;
		expect(status?.getAttribute('role')).toBe('alert');
		expect(document.activeElement).toBe(status); // focus lands on the alert, matching the success path
	});

	it('marks the block whose id matches highlightId as the cited passage', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), highlightId: 's2', onClose: () => {} }
		});
		flushSync();
		const cited = container.querySelectorAll('.reader__passage--cited');
		expect(cited.length).toBe(1);
		expect(cited[0]?.textContent).toContain('effective date'); // the s2 passage
		// the "Cited passage" label is a CSS ::before + aria-label, so it is NOT in the copyable text run
		expect(cited[0]?.textContent).not.toContain('Cited passage');
		expect(cited[0]?.getAttribute('role')).toBe('group');
		expect(cited[0]?.getAttribute('aria-label')).toBe('Cited passage');
		expect(cited[0]?.getAttribute('tabindex')).toBe('-1');
	});

	it('highlights nothing when highlightId is null or matches no block (graceful fallback)', () => {
		const nullId = render(SourceReader, {
			props: { source: source(), highlightId: null, onClose: () => {} }
		});
		flushSync();
		expect(nullId.container.querySelectorAll('.reader__passage--cited').length).toBe(0);

		const noMatch = render(SourceReader, {
			props: { source: source(), highlightId: 'does-not-exist', onClose: () => {} }
		});
		flushSync();
		expect(noMatch.container.querySelectorAll('.reader__passage--cited').length).toBe(0);
	});

	it('renders a section heading and a page marker where the metadata changes', () => {
		const src: Source = {
			sourceId: 's',
			title: 'S',
			url: 'https://www.va.gov/',
			passages: [
				{ id: 'a', text: 'first', page: 3, section: 'Eligibility' },
				{ id: 'b', text: 'second', page: 3, section: 'Eligibility' },
				{ id: 'c', text: 'third', page: 4, section: 'How to apply' }
			]
		};
		const { container } = render(SourceReader, {
			props: { source: src, highlightId: null, onClose: () => {} }
		});
		flushSync();
		const headings = container.querySelectorAll('h3.reader__section');
		expect(headings.length).toBe(2); // one per distinct section, not per block
		expect(headings[0]?.textContent).toBe('Eligibility');
		expect(headings[1]?.textContent).toBe('How to apply');
		expect(container.querySelectorAll('.reader__page').length).toBe(2); // page 3, then page 4
	});

	it('scrolls the cited passage into view and focuses it on open', () => {
		const passages = Array.from({ length: 24 }, (_, i) => ({
			id: `p${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		const tall: Source = {
			sourceId: 's',
			title: 'Big Source',
			url: 'https://www.va.gov/',
			passages
		};
		const { container } = render(SourceReader, {
			props: { source: tall, highlightId: 'p20', onClose: () => {} }
		});
		flushSync();
		const body = container.querySelector('.reader__body') as HTMLElement;
		const cited = container.querySelector('.reader__passage--cited') as HTMLElement;
		expect(body.scrollTop).toBeGreaterThan(0); // scrolled down to the cited block, not left at the top
		expect(document.activeElement).toBe(cited); // focus landed on the cited region
	});

	it('device mode (default): copy references on-device storage and no-connection', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		const held = container.querySelector('.reader__held') as HTMLElement;
		expect(held.textContent).toMatch(/on your device/i);
		expect(held.classList.contains('reader__held--neutral')).toBe(false);
		expect(container.querySelector('.reader__muted')?.textContent).toMatch(/no connection needed/i);
	});

	it('online mode: neutral copy, no on-device / no-connection framing', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), online: true, onClose: () => {} }
		});
		flushSync();
		const held = container.querySelector('.reader__held') as HTMLElement;
		expect(held.textContent).toMatch(/passage this answer found/i);
		expect(held.textContent).not.toMatch(/on your device/i);
		expect(held.classList.contains('reader__held--neutral')).toBe(true);
		// the on-device footer note is omitted for online answers
		expect(container.querySelector('.reader__muted')).toBeNull();
	});

	// The held line as it is drawn: markup that wraps a sentence puts a newline and indentation into
	// textContent, which the browser collapses to one space on screen.
	const heldText = (container: Element) =>
		container.querySelector('.reader__held')?.textContent?.replace(/\s+/g, ' ').trim();
	// A real PDF source. With no passage cited it has no page to open at, so it shows the text view alone.
	const pdfSource = () =>
		source({
			sourceId: 'tap_vet_centers',
			title: 'TAP - Vet Centers (Resource Guide)',
			url: 'https://www.tapevents.mil/resources/documents'
		});

	// A web page is never re-hosted, so the reader says there is no document to open and where the link goes.
	it('device mode, web page: says there is no document to open and the link goes to the live page', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		expect(heldText(container)).toBe(
			'Showing the text saved on your device. This source is a web page, so there is no document to open here - the link below goes to the live page.'
		);
	});

	it('online mode, web page: says there is no document to open and the link goes to the live page', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), online: true, onClose: () => {} }
		});
		flushSync();
		expect(heldText(container)).toBe(
			'Showing the passage this answer found. This source is a web page, so there is no document to open here - the link below goes to the live page.'
		);
	});

	// A PDF source has a document, so it never claims to be a web page.
	it('device mode, PDF source: keeps pointing to the official site for the complete original', () => {
		const { container } = render(SourceReader, {
			props: { source: pdfSource(), onClose: () => {} }
		});
		flushSync();
		expect(heldText(container)).toBe(
			'Showing the text saved on your device - open the official site for the complete original.'
		);
	});

	// The text lands on the cited passage, often far down, so a line at the top of the scroll would be out of
	// sight the moment the reader opens. A web page's line says why there is no page view: it stays pinned.
	it("pins a web page's line above the scroll, in sight after landing on a passage far down", () => {
		const passages = Array.from({ length: 24 }, (_, i) => ({
			id: `p${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		const { container } = render(SourceReader, {
			props: { source: source({ passages }), highlightId: 'p20', onClose: () => {} }
		});
		flushSync();
		const body = container.querySelector('.reader__body') as HTMLElement;
		const held = container.querySelector('.reader__held') as HTMLElement;
		expect(body.scrollTop).toBeGreaterThan(0);
		expect(container.querySelectorAll('.reader__held')).toHaveLength(1);
		expect(body.contains(held)).toBe(false);
		const dialog = (
			container.querySelector('dialog.reader') as HTMLElement
		).getBoundingClientRect();
		expect(held.getBoundingClientRect().top).toBeGreaterThanOrEqual(dialog.top);
		expect(held.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			body.getBoundingClientRect().top
		);
	});

	it("keeps a PDF source's line at the top of its text, inside the scroll", () => {
		const { container } = render(SourceReader, {
			props: { source: pdfSource(), onClose: () => {} }
		});
		flushSync();
		const body = container.querySelector('.reader__body') as HTMLElement;
		expect(body.contains(container.querySelector('.reader__held'))).toBe(true);
	});

	it('online mode, PDF source: keeps saying the whole text comes with the offline library', () => {
		const { container } = render(SourceReader, {
			props: { source: pdfSource(), online: true, onClose: () => {} }
		});
		flushSync();
		expect(heldText(container)).toBe(
			'Showing the passage this answer found. The whole text comes with the answer library Ask uses offline.'
		);
	});

	it('online mode loading: status drops the on-device wording', () => {
		const { container } = render(SourceReader, {
			props: { source: null, loading: true, online: true, onClose: () => {} }
		});
		flushSync();
		const status = container.querySelector('.reader__status') as HTMLElement;
		expect(status.textContent).toMatch(/loading the source/i);
		expect(status.textContent).not.toMatch(/on your device/i);
	});

	// The reader is the deepest tier: it is ALREADY showing the exact passage. Sending its link out to the
	// shared TAP library directory page would walk the reader back to a list of 21 documents, so it
	// resolves the guide and anchors the highlighted passage's own page.
	it('links a TAP guide to the highlighted passage page in the real document', () => {
		const { container } = render(SourceReader, {
			props: {
				source: source({
					sourceId: 'tap_vet_centers',
					url: 'https://www.tapevents.mil/resources/documents',
					passages: [
						{ id: 's1', text: 'Vet Centers offer readjustment counseling.', page: 1 },
						{ id: 's2', text: 'Services are free and confidential.', page: 2 }
					]
				}),
				highlightId: 's2',
				onClose: () => {}
			}
		});
		flushSync();
		const link = container.querySelector('.reader__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(
			'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf#page=2'
		);
	});

	it('links a TAP guide to the document itself when no passage is highlighted', () => {
		const { container } = render(SourceReader, {
			props: {
				source: source({
					sourceId: 'tap_vet_centers',
					url: 'https://www.tapevents.mil/resources/documents'
				}),
				onClose: () => {}
			}
		});
		flushSync();
		const link = container.querySelector('.reader__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(
			'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf'
		);
	});
});

// A source with a served document opens on its page, with the text one tap away. `tap_vet_centers` is a real
// entry in the generated document map, so these run the real map, cache check and lazy page view; only the
// PDF library is replaced, through the same seam the page view uses.
describe('SourceReader with a served document', () => {
	// The reader loads its page view, pager and Save lazily. Loaded once here, each test renders against loaded
	// modules, as the app does after a first open; a cold load under a busy full run can outlast a wait below.
	beforeAll(async () => {
		await import('./reader-parts');
	});
	const served = (): Source =>
		source({
			sourceId: 'tap_vet_centers',
			url: 'https://www.tapevents.mil/resources/documents',
			passages: [
				{ id: 's1', text: 'Vet Centers offer readjustment counseling.', page: 1 },
				{
					id: 's2',
					text: 'Services are free and confidential.',
					page: 2,
					anchor: 'Services are free and confidential.'
				}
			]
		});
	// The text as it is drawn: markup that wraps a sentence puts a newline and indentation into textContent,
	// which the browser collapses to one space on screen.
	const shown = (container: Element) => container.textContent?.replace(/\s+/g, ' ') ?? '';
	const seg = (container: Element, label: string) =>
		[...container.querySelectorAll('.seg button')].find((b) => b.textContent?.trim() === label) as
			HTMLButtonElement | undefined;
	const failingLoader = async (): Promise<PdfRuntime> => ({
		getDocument: () => ({
			promise: Promise.reject(new Error('E_TEST_LOAD')),
			destroy: async () => {}
		})
	});
	// A library that never arrives holds the page view in its loading state.
	const pendingLoader = () => new Promise<PdfRuntime>(() => {});
	// A two-page document that does not carry the cited passage, so the page view says it could not mark it.
	const withoutPassage = async (): Promise<PdfRuntime> => {
		const doc: PdfDocument = {
			numPages: 2,
			async getPage() {
				return {
					getViewport: ({ scale }) => ({
						width: 600 * scale,
						height: 800 * scale,
						transform: [scale, 0, 0, -scale, 0, 800 * scale]
					}),
					render: () => ({ promise: Promise.resolve(), cancel() {} }),
					getTextContent: async () => ({
						items: [
							{ str: 'Unrelated text.', transform: [10, 0, 0, 10, 40, 720], width: 60, height: 10 }
						]
					}),
					cleanup() {}
				};
			}
		};
		return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
	};

	it('opens on the original page, with a switch to the text', async () => {
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: pendingLoader }
		});

		await vi.waitFor(() =>
			expect(seg(container, 'Page')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('false');
		// This document is not in the test browser's cache; online, the page view opens at once and states its size.
		await vi.waitFor(() =>
			expect(shown(container)).toContain('Loading page 2 of the document (0.1 MB)...')
		);
		expect(container.querySelector('.reader__text')?.hasAttribute('hidden')).toBe(true);
	});

	it('shows the text, with the cited passage focused, when the switch picks Text', async () => {
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {} }
		});

		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await vi.waitFor(() =>
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(container.querySelector('.reader__text')?.hasAttribute('hidden')).toBe(false);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
		);
	});

	it('falls back to the text, disabling the page and saying why, when the document fails to load', async () => {
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: failingLoader }
		});

		await vi.waitFor(() =>
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(seg(container, 'Page')?.disabled).toBe(true);
		expect(shown(container)).toContain(
			'The document could not be opened, so this is the text saved on your device.'
		);
		// The view the user was reading changed under them, so a screen reader is told at once.
		expect(container.querySelector('.reader__notice')?.getAttribute('role')).toBe('alert');
	});

	// An online answer's text is the passage the search found, and nothing of it is kept on the device. The alert
	// is heard alone, so it says what the reader now shows.
	it('says it shows the passage the answer found when an online answer cannot open the page', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: served(),
				highlightId: 's2',
				online: true,
				onClose: () => {},
				pdfLoader: failingLoader
			}
		});

		await vi.waitFor(() =>
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(container.querySelector('.reader__notice')?.textContent?.trim()).toBe(
			'The document could not be opened, so this is the passage this answer found.'
		);
		expect(shown(container)).not.toContain('saved on your device');
		expect(container.querySelector('.reader__notice')?.getAttribute('role')).toBe('alert');
	});

	it('goes straight to the text, saying so, when offline with the document never saved', async () => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
		try {
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {} }
			});

			await vi.waitFor(() =>
				expect(shown(container)).toContain(
					'This document is not saved on this device. Save it for offline use when you have a connection.'
				)
			);
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true');
			expect(seg(container, 'Page')?.disabled).toBe(true);
			// It takes the place of the pages the user opened, as a failure does, so it is said as an alert: a polite
			// line put in with its words already in it is not always spoken.
			expect(container.querySelector('.reader__notice')?.getAttribute('role')).toBe('alert');
		} finally {
			// Removing the own property restores the browser's real getter on the prototype.
			delete (navigator as unknown as Record<string, unknown>).onLine;
		}
	});

	// The Save says the first save also stores the answer library while it is missing. Opening the text online
	// can store it, so the line is checked again when the view changes.
	it('checks the Save line about the answer library again when the view changes', async () => {
		await caches.delete(ASK_ASSET_CACHE);
		try {
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: pendingLoader }
			});
			const line = () => container.querySelector('.save__line');
			await vi.waitFor(() => expect(line()).not.toBeNull());
			expect(shown(line() as Element).trim()).toBe(
				'The first save also stores the answer library (7.3 MB), once.'
			);

			const cache = await caches.open(ASK_ASSET_CACHE);
			await cache.put('/corpus/corpus-v1.0.2.json', new Response('{}'));
			await cache.put('/corpus/corpus-v1.0.2.embeddings.bin', new Response('vectors'));
			seg(container, 'Text')?.click();
			await vi.waitFor(() => expect(line()).toBeNull());
		} finally {
			await caches.delete(ASK_ASSET_CACHE);
		}
	});

	// Saved once, then updated: offline, the older copy is on the device and the new version is not.
	it('says the new version is not saved, offline, when an older copy of the document is', async () => {
		await caches.delete(ASK_ASSET_CACHE);
		await (
			await caches.open(ASK_ASSET_CACHE)
		).put('/docs/tap_vet_centers.0badc0de.pdf', new Response('pdf'));
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
		try {
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {} }
			});

			await vi.waitFor(() =>
				expect(shown(container)).toContain(
					'The new version of this document is not saved on this device. Save it again when you have a connection.'
				)
			);
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true');
			expect(container.querySelector('.reader__notice')?.getAttribute('role')).toBe('alert');
		} finally {
			delete (navigator as unknown as Record<string, unknown>).onLine;
			await caches.delete(ASK_ASSET_CACHE);
		}
	});

	it('switches to the text when the page view offers it and the user takes it', async () => {
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: withoutPassage }
		});
		const instead = () =>
			[...container.querySelectorAll('button')].find(
				(b) => b.textContent?.trim() === 'Show it in the text'
			);

		await vi.waitFor(() => expect(instead()).toBeDefined());
		instead()?.click();
		await vi.waitFor(() =>
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(container.querySelector('.reader__text')?.hasAttribute('hidden')).toBe(false);
	});

	// The note's status line is in place, empty and taking no room, before there is anything to say, and that
	// same line then says it: a status line put in with its words already in it is not always spoken.
	it("keeps the note's status line in place before the note, and says the note in that same line", async () => {
		let arrive!: () => void;
		const held = new Promise<void>((resolve) => (arrive = resolve));
		const loader = async (): Promise<PdfRuntime> => {
			const runtime = await withoutPassage();
			await held;
			return runtime;
		};
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: loader }
		});
		// The spacing and the rule the app defines globally, so an empty line that kept them would show it.
		container.style.setProperty('--space-s', '8px');
		container.style.setProperty('--space-l', '16px');
		container.style.setProperty('--color-border', 'rgb(1, 2, 3)');
		await vi.waitFor(() => expect(container.querySelector('.reader__note')).not.toBeNull());
		const line = container.querySelector('.reader__note') as HTMLElement;
		expect(line.getAttribute('role')).toBe('status');
		expect(shown(line).trim()).toBe('');
		expect(line.getBoundingClientRect().height).toBe(0);

		arrive();
		await vi.waitFor(() =>
			expect(shown(line)).toContain('The passage could not be marked on this page.')
		);
		expect(container.querySelector('.reader__note')).toBe(line);
	});

	// Turning the phone builds the note again in its other place, and focus goes back to its button.
	it("gives focus back to the note's button when the screen turns", async () => {
		const size = { width: window.innerWidth, height: window.innerHeight };
		try {
			await page.viewport(844, 800);
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: withoutPassage }
			});
			const act = () => container.querySelector('.reader__act');
			await vi.waitFor(() =>
				expect(document.activeElement?.classList.contains('pdf__page')).toBe(true)
			);
			await vi.waitFor(() => expect(act()).not.toBeNull());
			(act() as HTMLElement).focus();

			await page.viewport(844, 390);
			await vi.waitFor(() =>
				expect(container.querySelector('.reader__body .reader__note .reader__act')).not.toBeNull()
			);
			await vi.waitFor(() => expect(document.activeElement).toBe(act()));
		} finally {
			await page.viewport(size.width, size.height);
		}
	});

	// A document can take a while to load. A user who moves focus meanwhile - to a link, to the Save - is not
	// pulled back by the landing. Outside the scroll, the view still goes to the passage; on the Save above the
	// pages in the scroll, it stays where the user is.
	describe('a landing after the user moved focus', () => {
		const heldLoader = () => {
			let arrive!: () => void;
			const held = new Promise<void>((resolve) => (arrive = resolve));
			const loader = async (): Promise<PdfRuntime> => {
				const doc: PdfDocument = {
					numPages: 3,
					async getPage(n) {
						return {
							getViewport: ({ scale }) => ({
								width: 600 * scale,
								height: 800 * scale,
								transform: [scale, 0, 0, -scale, 0, 800 * scale]
							}),
							render: () => ({ promise: Promise.resolve(), cancel() {} }),
							getTextContent: async () => ({
								items: [
									{
										str: n === 2 ? 'Services are free and confidential.' : 'Other text.',
										transform: [10, 0, 0, 10, 40, 720],
										width: 180,
										height: 10
									}
								]
							}),
							cleanup() {}
						};
					}
				};
				return { getDocument: () => ({ promise: held.then(() => doc), destroy: async () => {} }) };
			};
			return { loader, arrive: () => arrive() };
		};

		it('leaves focus on a link the user moved to, and still shows the passage', async () => {
			const { loader, arrive } = heldLoader();
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: loader }
			});
			const link = () => container.querySelectorAll('.reader__link')[1] as HTMLElement;
			await vi.waitFor(() => expect(link()).toBeDefined());
			link().focus();

			arrive();
			await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(document.activeElement).toBe(link());
			await vi.waitFor(() =>
				expect((container.querySelector('.pager input') as HTMLInputElement | null)?.value).toBe(
					'2'
				)
			);
		});

		it('leaves focus on a link the user moved to when the document fails and the text shows', async () => {
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: failingLoader }
			});
			const link = () => container.querySelectorAll('.reader__link')[1] as HTMLElement;
			await vi.waitFor(() => expect(link()).toBeDefined());
			link().focus();

			await vi.waitFor(() =>
				expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
			);
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			expect(document.activeElement).toBe(link());
		});

		// Far down a long text, the passage is still shown, though focus stays where the user put it. Text follows
		// it, as in a real source, so the view can bring it to the top.
		const filler = (from: number) =>
			Array.from({ length: 30 }, (_, i) => ({
				id: `t${from + i}`,
				text: `Passage number ${from + i} with enough words to give the reader real height to scroll through.`
			}));
		const long = (): Source => ({
			...served(),
			passages: [...filler(0), ...served().passages, ...filler(30)]
		});
		const inBodyView = (container: Element, el: Element) => {
			const body = (
				container.querySelector('.reader__body') as HTMLElement
			).getBoundingClientRect();
			const box = el.getBoundingClientRect();
			return box.top >= body.top - 1 && box.top < body.bottom;
		};

		it('still shows the passage in the text when the user moved focus out of the scroll', async () => {
			const { container } = render(SourceReader, {
				props: { source: long(), highlightId: 's2', onClose: () => {}, pdfLoader: failingLoader }
			});
			const link = () => container.querySelectorAll('.reader__link')[1] as HTMLElement;
			await vi.waitFor(() => expect(link()).toBeDefined());
			link().focus();

			await vi.waitFor(() =>
				expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
			);
			const cited = container.querySelector('.reader__passage--cited') as HTMLElement;
			await vi.waitFor(() => expect(inBodyView(container, cited)).toBe(true));
			expect(document.activeElement).toBe(link());
		});

		// On a short screen the links sit in the scroll, above the text: scrolling to the passage would carry the
		// user's focus away, so the text stays where the user is.
		it('keeps the text still when the user moved focus onto a control in the scroll', async () => {
			const size = { width: window.innerWidth, height: window.innerHeight };
			try {
				await page.viewport(844, 390);
				const { container } = render(SourceReader, {
					props: { source: long(), highlightId: 's2', onClose: () => {}, pdfLoader: failingLoader }
				});
				const body = container.querySelector('.reader__body') as HTMLElement;
				const link = () => container.querySelectorAll('.reader__link')[1] as HTMLElement;
				await vi.waitFor(() => expect(body.contains(link())).toBe(true));
				link().focus();

				await vi.waitFor(() =>
					expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
				);
				await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				expect(document.activeElement).toBe(link());
				expect(body.scrollTop).toBe(0);
			} finally {
				await page.viewport(size.width, size.height);
			}
		});

		// The passage found on a later page than the one cited: the view lands on the cited page, then on the page
		// it found - focus already in the pages goes with it.
		it('moves focus from the page landed on to the page the passage was found on', async () => {
			const found = async (): Promise<PdfRuntime> => {
				const doc: PdfDocument = {
					numPages: 3,
					async getPage(n) {
						return {
							getViewport: ({ scale }) => ({
								width: 600 * scale,
								height: 800 * scale,
								transform: [scale, 0, 0, -scale, 0, 800 * scale]
							}),
							render: () => ({ promise: Promise.resolve(), cancel() {} }),
							getTextContent: async () => ({
								items: [
									{
										str: n === 3 ? 'Services are free and confidential.' : 'Other text.',
										transform: [10, 0, 0, 10, 40, 720],
										width: 180,
										height: 10
									}
								]
							}),
							cleanup() {}
						};
					}
				};
				return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
			};
			const { container } = render(SourceReader, {
				props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: found }
			});

			await vi.waitFor(() =>
				expect(document.activeElement).toBe(container.querySelector('[data-page="3"]'))
			);
		});
	});

	// Opened while its source still loads, the reader's title bar is drawn again once the source arrives, and the
	// Close that held focus goes with it. Focus fallen to the page is the landing's to take.
	it('lands on the cited passage when the source arrives after the loading state', async () => {
		const { container, rerender } = render(SourceReader, {
			props: { source: null, loading: true, onClose: () => {} }
		});
		await vi.waitFor(() =>
			expect((container.querySelector('dialog') as HTMLDialogElement).open).toBe(true)
		);
		(container.querySelector('.reader__close') as HTMLElement).focus();

		await rerender({ source: source(), highlightId: 's2', loading: false });
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
		);
	});

	// Viewing keeps nothing, so the foot is where a document opened from an answer is kept. It leads the foot,
	// ahead of the links out. This document is not in the cache here, so the Save is offered.
	it('offers to save the document for offline, first in the foot', async () => {
		await caches.delete(ASK_ASSET_CACHE);
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: pendingLoader }
		});

		await vi.waitFor(() =>
			expect(container.querySelector('.reader__foot')?.firstElementChild?.textContent?.trim()).toBe(
				'Save for offline (0.1 MB)'
			)
		);
		expect(
			[...container.querySelectorAll('.reader__link')].map((a) => a.textContent?.trim())
		).toEqual(['View on the official site', 'All documents']);
	});

	// Cited as page 2, found on page 3: the reader lands there, and a note pinned above the scroll names both
	// pages so the citation stays honest, with the text one tap away.
	it('notes a passage found on another page above the page view, and shows it in the text', async () => {
		const found = async (): Promise<PdfRuntime> => {
			const doc: PdfDocument = {
				numPages: 3,
				async getPage(n) {
					return {
						getViewport: ({ scale }) => ({
							width: 600 * scale,
							height: 800 * scale,
							transform: [scale, 0, 0, -scale, 0, 800 * scale]
						}),
						render: () => ({ promise: Promise.resolve(), cancel() {} }),
						getTextContent: async () => ({
							items: [
								{
									str: n === 3 ? 'Services are free and confidential.' : 'Other text.',
									transform: [10, 0, 0, 10, 40, 720],
									width: 180,
									height: 10
								}
							]
						}),
						cleanup() {}
					};
				}
			};
			return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
		};
		const { container } = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: found }
		});

		await vi.waitFor(() =>
			expect(container.querySelector('.reader__note .reader__act')).not.toBeNull()
		);
		const note = container.querySelector('.reader__note') as HTMLElement;
		expect(shown(note)).toContain('Cited as page 2. The passage starts on page 3, marked below.');
		// The view landed on a page other than the one cited; a screen reader hears why.
		expect(note.getAttribute('role')).toBe('status');
		expect(note.previousElementSibling?.classList.contains('reader__switch')).toBe(true);
		expect(note.nextElementSibling?.classList.contains('reader__body')).toBe(true);

		[...note.querySelectorAll('button')]
			.find((b) => b.textContent?.trim() === 'Show it in the text')
			?.click();
		await vi.waitFor(() =>
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true')
		);
		expect(shown(container.querySelector('.reader__note') as Element).trim()).toBe('');
	});

	// "Held on your device" is true of the answer library's text, not of a document the user has not saved.
	// Where a document is served, its Save says exactly what is kept, so the foot claims nothing more.
	it('claims nothing is held on the device where a document is served, from an answer or the list', async () => {
		const answer = render(SourceReader, {
			props: { source: served(), highlightId: 's2', onClose: () => {}, pdfLoader: pendingLoader }
		});
		const whole = render(SourceReader, {
			props: {
				source: null,
				doc: { sourceId: 'tap_vet_centers', title: 'TAP - Vet Centers (Resource Guide)' },
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: pendingLoader
			}
		});
		for (const { container } of [answer, whole]) {
			await vi.waitFor(() => expect(container.querySelector('.reader__foot')).not.toBeNull());
			expect(container.querySelector('.reader__foot')?.textContent).not.toMatch(
				/no connection needed/i
			);
		}
	});

	// Both views scroll in the one body. Back from the text, the page view is where the reader left it, and the
	// pager names the page in view - not the last page, which is what pages measured while hidden would name.
	it('returns to the page left, and names it, after a visit to the text', async () => {
		const twelve = async (): Promise<PdfRuntime> => {
			const doc: PdfDocument = {
				numPages: 12,
				async getPage(n) {
					return {
						getViewport: ({ scale }) => ({
							width: 600 * scale,
							height: 800 * scale,
							transform: [scale, 0, 0, -scale, 0, 800 * scale]
						}),
						render: () => ({ promise: Promise.resolve(), cancel() {} }),
						getTextContent: async () => ({
							items: [
								{
									str: n === 9 ? 'Services are free and confidential.' : 'Other text.',
									transform: [10, 0, 0, 10, 40, 720],
									width: 180,
									height: 10
								}
							]
						}),
						cleanup() {}
					};
				}
			};
			return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
		};
		// Text long enough to scroll, with the cited passage in its middle, so the text has a place of its own.
		const passages: Source['passages'] = Array.from({ length: 30 }, (_, i) => ({
			id: `t${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		passages.splice(15, 0, {
			id: 'cited',
			text: 'Services are free and confidential.',
			page: 9,
			anchor: 'Services are free and confidential.'
		});
		const { container } = render(SourceReader, {
			props: {
				source: source({ sourceId: 'tap_vet_centers', passages }),
				highlightId: 'cited',
				onClose: () => {},
				pdfLoader: twelve
			}
		});
		const body = container.querySelector('.reader__body') as HTMLElement;
		const number = () => container.querySelector('.pager input') as HTMLInputElement | null;
		const inView = () =>
			pageInView(
				[...container.querySelectorAll('[data-page]')].map(
					(el) => el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
				),
				body.scrollTop,
				body.clientHeight
			);
		await vi.waitFor(() => expect(number()?.value).toBe('9'));
		const landed = body.scrollTop;
		expect(landed).toBeGreaterThan(0);
		expect(inView()).toBe(9);

		seg(container, 'Text')?.click();
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
		);
		body.scrollTop = 0;
		// Two frames: the scroll is reported, and anything measuring on it has run.
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		seg(container, 'Page')?.click();

		await vi.waitFor(() => {
			expect(inView()).toBe(9);
			expect(number()?.value).toBe('9');
		});
		expect(body.scrollTop).toBeCloseTo(landed, 0);
	});

	// A phone turned while reading: every page takes the new width, and the view stays on the page it was on, the
	// pager naming it - whether the pages were up, or the text was and the pages come back after. The body keeps
	// no place of its own, as in WebKit, which has no scroll anchoring: the iPhone this is for.
	it.each([
		['with the pages up', false],
		['with the text up', true]
	])('keeps the page in view when the phone turns %s', async (_name, viaText) => {
		const size = { width: window.innerWidth, height: window.innerHeight };
		const passages: Source['passages'] = Array.from({ length: 30 }, (_, i) => ({
			id: `t${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		passages.splice(15, 0, {
			id: 'cited',
			text: 'Services are free and confidential.',
			page: 9,
			anchor: 'Services are free and confidential.'
		});
		const twelve = async (): Promise<PdfRuntime> => {
			const doc: PdfDocument = {
				numPages: 12,
				async getPage(n) {
					return {
						getViewport: ({ scale }) => ({
							width: 600 * scale,
							height: 800 * scale,
							transform: [scale, 0, 0, -scale, 0, 800 * scale]
						}),
						render: () => ({ promise: Promise.resolve(), cancel() {} }),
						getTextContent: async () => ({
							items: [
								{
									str: n === 9 ? 'Services are free and confidential.' : 'Other text.',
									transform: [10, 0, 0, 10, 40, 720],
									width: 180,
									height: 10
								}
							]
						}),
						cleanup() {}
					};
				}
			};
			return { getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} }) };
		};
		const settle = () =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			);
		try {
			await page.viewport(390, 844);
			const { container } = render(SourceReader, {
				props: {
					source: source({ sourceId: 'tap_vet_centers', passages }),
					highlightId: 'cited',
					onClose: () => {},
					pdfLoader: twelve
				}
			});
			const body = container.querySelector('.reader__body') as HTMLElement;
			body.style.overflowAnchor = 'none';
			const number = () => container.querySelector('.pager input') as HTMLInputElement | null;
			const inView = () =>
				pageInView(
					[...container.querySelectorAll('[data-page]')].map(
						(el) =>
							el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
					),
					body.scrollTop,
					body.clientHeight
				);
			// The page at the top of the view, and how far down it the top is: a page is taller than the view
			// once the phone is sideways, so the page number alone would miss a place hundreds of pixels off.
			const place = () => {
				const pages = [...container.querySelectorAll<HTMLElement>('[data-page]')];
				const tops = pages.map(
					(el) => el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
				);
				const n = pageInView(tops, body.scrollTop, 0);
				return { n, at: (body.scrollTop - (tops[n - 1] ?? 0)) / (pages[n - 1]?.clientHeight ?? 1) };
			};
			await vi.waitFor(() => expect(number()?.value).toBe('9'));
			expect(inView()).toBe(9);
			const before = place();
			if (viaText) {
				seg(container, 'Text')?.click();
				await vi.waitFor(() =>
					expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
				);
			}

			await page.viewport(844, 390);
			await settle();
			if (viaText) {
				seg(container, 'Page')?.click();
				await settle();
			}
			await vi.waitFor(() => {
				expect(inView()).toBe(9);
				expect(number()?.value).toBe('9');
			});
			expect(place().n).toBe(before.n);
			expect(place().at).toBeCloseTo(before.at, 2);
		} finally {
			await page.viewport(size.width, size.height);
		}
	});

	// The user can take the text while the page is still loading. The document arriving then must leave the text
	// where it is, and the page view still lands on the passage when the user comes back to it.
	it('keeps the text still when the page finishes loading behind it, and lands on the page after', async () => {
		let arrive!: () => void;
		const held = new Promise<void>((resolve) => (arrive = resolve));
		const twelve = async (): Promise<PdfRuntime> => {
			const doc: PdfDocument = {
				numPages: 12,
				async getPage(n) {
					return {
						getViewport: ({ scale }) => ({
							width: 600 * scale,
							height: 800 * scale,
							transform: [scale, 0, 0, -scale, 0, 800 * scale]
						}),
						render: () => ({ promise: Promise.resolve(), cancel() {} }),
						getTextContent: async () => ({
							items: [
								{
									str: n === 9 ? 'Services are free and confidential.' : 'Other text.',
									transform: [10, 0, 0, 10, 40, 720],
									width: 180,
									height: 10
								}
							]
						}),
						cleanup() {}
					};
				}
			};
			return { getDocument: () => ({ promise: held.then(() => doc), destroy: async () => {} }) };
		};
		const passages: Source['passages'] = Array.from({ length: 30 }, (_, i) => ({
			id: `t${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		passages.splice(15, 0, {
			id: 'cited',
			text: 'Services are free and confidential.',
			page: 9,
			anchor: 'Services are free and confidential.'
		});
		const { container } = render(SourceReader, {
			props: {
				source: source({ sourceId: 'tap_vet_centers', passages }),
				highlightId: 'cited',
				onClose: () => {},
				pdfLoader: twelve
			}
		});
		const body = container.querySelector('.reader__body') as HTMLElement;
		const number = () => container.querySelector('.pager input') as HTMLInputElement | null;
		const inView = () =>
			pageInView(
				[...container.querySelectorAll('[data-page]')].map(
					(el) => el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
				),
				body.scrollTop,
				body.clientHeight
			);
		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
		);
		const reading = body.scrollTop;
		expect(reading).toBeGreaterThan(0);

		arrive();
		await vi.waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(12));
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(body.scrollTop).toBe(reading);

		seg(container, 'Page')?.click();
		await vi.waitFor(() => {
			expect(inView()).toBe(9);
			expect(number()?.value).toBe('9');
		});
	});

	// Each view's place belongs to its source. The next source opens at its own top, not at the place kept in
	// the last one's text.
	it('carries no place in the text over to the next source', async () => {
		const long = Array.from({ length: 30 }, (_, i) => ({
			id: `t${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		const { container, rerender } = render(SourceReader, {
			props: {
				source: source({ ...served(), passages: [...served().passages, ...long] }),
				highlightId: 's2',
				onClose: () => {},
				pdfLoader: pendingLoader
			}
		});
		const body = container.querySelector('.reader__body') as HTMLElement;
		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.reader__passage--cited'))
		);
		body.scrollTop = 300;
		expect(body.scrollTop).toBe(300);
		seg(container, 'Page')?.click();

		// A web page with nothing cited: it shows its text at once, with no passage to land on.
		await rerender({ source: source({ passages: long }), highlightId: null });
		await vi.waitFor(() => expect(container.querySelector('.seg')).toBeNull());
		expect(body.scrollHeight).toBeGreaterThan(body.clientHeight + 300);
		expect(body.scrollTop).toBe(0);
	});

	it('keeps a web-page source on the text view, with no switch', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), highlightId: 's1', onClose: () => {} }
		});
		flushSync();
		expect(container.querySelector('.seg')).toBeNull();
		expect(container.querySelector('.reader__text')?.hasAttribute('hidden')).toBe(false);
	});
});

// The Documents area opens a document whole: there is no answer and no cited passage, and the text is built
// only when the user asks for it, because it comes from the corpus, several megabytes on a first load.
describe('SourceReader, a document opened whole', () => {
	const DOC = { sourceId: 'tap_vet_centers', title: 'TAP - Vet Centers (Resource Guide)' };
	const vetSource = (): Source => ({
		sourceId: 'tap_vet_centers',
		title: 'TAP - Vet Centers (Resource Guide)',
		url: 'https://www.tapevents.mil/resources/documents',
		passages: [
			{ id: 'v1', text: 'Vet Centers offer readjustment counseling.', page: 1 },
			{ id: 'v2', text: 'Services are free and confidential.', page: 2 }
		]
	});
	const shown = (container: Element) => container.textContent?.replace(/\s+/g, ' ') ?? '';
	const seg = (container: Element, label: string) =>
		[...container.querySelectorAll('.seg button')].find((b) => b.textContent?.trim() === label) as
			HTMLButtonElement | undefined;
	const button = (container: Element, label: string) =>
		[...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

	it('opens titled, on its first page, at once, stating its size, with no text built', async () => {
		const loadSource = vi.fn(async () => vetSource());
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource,
				onClose: () => {},
				pdfLoader: () => new Promise<PdfRuntime>(() => {})
			}
		});

		await vi.waitFor(() =>
			expect(shown(container)).toContain('Loading page 1 of the document (0.1 MB)...')
		);
		expect((container.querySelector('dialog.reader') as HTMLDialogElement).open).toBe(true);
		expect(container.querySelector('.reader__title')?.textContent).toBe(DOC.title);
		expect(seg(container, 'Page')?.getAttribute('aria-pressed')).toBe('true');
		expect(button(container, 'Open page 1')).toBeUndefined();
		expect(loadSource).not.toHaveBeenCalled();
	});

	it('builds the text when the user picks it, and shows the whole document with nothing cited', async () => {
		const loadSource = vi.fn(async () => vetSource());
		const { container } = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource, onClose: () => {} }
		});

		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await vi.waitFor(() =>
			expect(shown(container)).toContain('Services are free and confidential.')
		);
		expect(loadSource).toHaveBeenCalledWith('tap_vet_centers');
		expect(shown(container)).toContain('Vet Centers offer readjustment counseling.');
		expect(container.querySelector('.reader__passage--cited')).toBeNull();
	});

	// A document from the list is always a served PDF, so its text never claims to be a web page.
	it("says a listed document's text is the device's copy, never a web page", async () => {
		const { container } = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource: async () => vetSource(), onClose: () => {} }
		});

		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await vi.waitFor(() => expect(container.querySelector('.reader__held')).not.toBeNull());
		expect(container.querySelector('.reader__held')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
			'Showing the text saved on your device - open the official site for the complete original.'
		);
	});

	// A build that fails is reported, not retried in a loop. The loader answers on a later timer tick, so a
	// retry loop shows up as a count here rather than as a page that never yields.
	it('says the text could not be loaded when it cannot be built, and does not retry', async () => {
		const loadSource = vi.fn(
			() => new Promise<Source | null>((resolve) => setTimeout(() => resolve(null), 0))
		);
		const { container } = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource, onClose: () => {} }
		});

		await vi.waitFor(() => expect(seg(container, 'Text')).toBeDefined());
		seg(container, 'Text')?.click();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(loadSource).toHaveBeenCalledTimes(1);
		await vi.waitFor(() =>
			expect(shown(container)).toContain(
				'This source could not be loaded right now. Check your connection and try again.'
			)
		);
	});

	it('offline, with the document never saved, goes to the text and builds it', async () => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
		try {
			const loadSource = vi.fn(async () => vetSource());
			const { container } = render(SourceReader, {
				props: { source: null, doc: DOC, loadSource, onClose: () => {} }
			});

			await vi.waitFor(() =>
				expect(shown(container)).toContain('Services are free and confidential.')
			);
			expect(shown(container)).toContain(
				'This document is not saved on this device. Save it for offline use when you have a connection.'
			);
			expect(seg(container, 'Text')?.getAttribute('aria-pressed')).toBe('true');
		} finally {
			delete (navigator as unknown as Record<string, unknown>).onLine;
		}
	});

	// Nothing was cited, so the page carries no mark and the reader reports no passage it could not find.
	it('opens the first page with no notice about a passage', async () => {
		const page: PdfDocument = {
			numPages: 2,
			async getPage() {
				return {
					getViewport: ({ scale }) => ({
						width: 600 * scale,
						height: 800 * scale,
						transform: [scale, 0, 0, -scale, 0, 800 * scale]
					}),
					render: () => ({ promise: Promise.resolve(), cancel() {} }),
					getTextContent: async () => ({
						items: [
							{ str: 'Vet Centers.', transform: [10, 0, 0, 10, 40, 720], width: 60, height: 10 }
						]
					}),
					cleanup() {}
				};
			}
		};
		const pdfLoader = async (): Promise<PdfRuntime> => ({
			getDocument: () => ({ promise: Promise.resolve(page), destroy: async () => {} })
		});
		const { container } = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource: async () => null, onClose: () => {}, pdfLoader }
		});

		await vi.waitFor(() => expect(container.querySelector('[data-page="2"]')).not.toBeNull());
		expect(shown(container)).toContain('A copy of the official document, without its pictures.');
		expect(shown(container.querySelector('.reader__note') as Element).trim()).toBe('');
	});

	// Opened from the Documents list, a document that cannot be drawn shows its own text, not an answer's passage.
	it('says a document from the list that cannot be opened is shown as its text', async () => {
		const failing = async (): Promise<PdfRuntime> => ({
			getDocument: () => ({
				promise: Promise.reject(new Error('E_TEST_LOAD')),
				destroy: async () => {}
			})
		});
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => vetSource(),
				onClose: () => {},
				pdfLoader: failing
			}
		});

		await vi.waitFor(() =>
			expect(shown(container.querySelector('.reader__notice') ?? container).trim()).toBe(
				'The document could not be opened, so this is its text.'
			)
		);
		expect(container.querySelector('.reader__notice')?.getAttribute('role')).toBe('alert');
	});

	// WebKit's Tab passes over a scrolling box with nothing in it to focus, so the keys could not reach a whole
	// document's text, which lands on no passage. The text is a named stop of its own, as the pages are.
	it('makes the text a named stop in the tab order, as the pages are', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => vetSource(),
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
		seg(container, 'Text')?.click();
		const text = container.querySelector('.reader__text') as HTMLElement;
		await vi.waitFor(() => expect(text.hidden).toBe(false));

		expect(text.getAttribute('role')).toBe('region');
		expect(text.getAttribute('aria-label')).toBe('Document text');
		expect(text.tabIndex).toBe(0);
	});

	// A web page's text is not a document's, and it lands on its passage, which takes focus.
	it("leaves a web page's text out of the tab order, unnamed", () => {
		const { container } = render(SourceReader, { props: { source: source(), onClose: () => {} } });
		flushSync();
		const text = container.querySelector('.reader__text') as HTMLElement;
		expect(text.hasAttribute('role')).toBe(false);
		expect(text.hasAttribute('aria-label')).toBe(false);
		expect(text.hasAttribute('tabindex')).toBe(false);
	});

	// Each view keeps its own place. Back in the text, the reader is where they left the text, not where they
	// left the pages.
	it('keeps the text where it was left, not where the pages were scrolled', async () => {
		const long = (): Source => ({
			...vetSource(),
			passages: Array.from({ length: 40 }, (_, i) => ({
				id: `w${i}`,
				text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
			}))
		});
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => long(),
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		const body = container.querySelector('.reader__body') as HTMLElement;
		const settle = () =>
			new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());

		seg(container, 'Text')?.click();
		await vi.waitFor(() => expect(container.querySelectorAll('.reader__passage')).toHaveLength(40));
		body.scrollTop = 300;
		await settle();
		seg(container, 'Page')?.click();
		await settle();
		body.scrollTop = 900;
		await settle();
		expect(body.scrollTop).toBe(900);

		seg(container, 'Text')?.click();
		await settle();
		expect(body.scrollTop).toBe(300);
	});

	/** A three-page document whose pages each say which page they are. */
	function threePages(): () => Promise<PdfRuntime> {
		const doc: PdfDocument = {
			numPages: 3,
			async getPage(n) {
				return {
					getViewport: ({ scale }) => ({
						width: 600 * scale,
						height: 800 * scale,
						transform: [scale, 0, 0, -scale, 0, 800 * scale]
					}),
					render: () => ({ promise: Promise.resolve(), cancel() {} }),
					getTextContent: async () => ({
						items: [
							{
								str: `Body of page ${n}.`,
								transform: [10, 0, 0, 10, 40, 720],
								width: 60,
								height: 10
							}
						]
					}),
					cleanup() {}
				};
			}
		};
		return async () => ({
			getDocument: () => ({ promise: Promise.resolve(doc), destroy: async () => {} })
		});
	}

	// Pinned: a sibling of the scrolling body, between it and the foot, so it never scrolls away.
	it('pages through the whole document with a pager pinned between the page and the foot', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
		const pager = container.querySelector('.pager') as HTMLElement;
		expect(pager.previousElementSibling?.classList.contains('reader__body')).toBe(true);
		expect(pager.nextElementSibling?.classList.contains('reader__foot')).toBe(true);
		const number = pager.querySelector('input') as HTMLInputElement;
		expect(number.value).toBe('1');

		// A typed page scrolls the reader's body there - its top just below the body's top - and the number
		// shows it.
		number.value = '2';
		number.dispatchEvent(new Event('change', { bubbles: true }));
		const body = container.querySelector('.reader__body') as HTMLElement;
		const second = container.querySelector('[data-page="2"]') as HTMLElement;
		await vi.waitFor(() =>
			expect(second.getBoundingClientRect().top - body.getBoundingClientRect().top).toBeCloseTo(
				8,
				-1
			)
		);
		expect(number.value).toBe('2');
		expect(button(pager, 'Next')).toBeUndefined();
	});

	// The line saying what the pages are sits above the first page, so opening at the first page's own top
	// would scroll it out of view the moment the document opens.
	it('opens a document from the list at its very top, the line above the first page in view', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		// The pager appears once the page view is ready, and the view lands as it becomes ready.
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
		const body = container.querySelector('.reader__body') as HTMLElement;
		const held = container.querySelector('.doc__held') as HTMLElement;
		expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
		expect(held.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			body.getBoundingClientRect().top
		);
		expect(body.scrollTop).toBe(0);
	});

	// The pages are out of the tab order - each takes focus only to land on it - so once focus leaves them the
	// keyboard needs a stop of its own to come back to the pages and scroll them.
	it('lets the keyboard return to the pages from the pager and scroll them', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
		const region = container.querySelector('.reader__doc') as HTMLElement;
		const body = container.querySelector('.reader__body') as HTMLElement;

		(container.querySelector('.pager input') as HTMLInputElement).focus();
		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(region);
		const before = body.scrollTop;
		await userEvent.keyboard('{PageDown}');
		await vi.waitFor(() => expect(body.scrollTop).toBeGreaterThan(before));
		// A stop in the tab order is named, so a screen reader says what it has reached.
		expect(region.getAttribute('role')).toBe('region');
		expect(region.getAttribute('aria-label')).toBe('Document pages');
	});

	it('shows no pager on the text view', async () => {
		const { container } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
		seg(container, 'Text')?.click();
		await vi.waitFor(() => expect(container.querySelector('.pager')).toBeNull());
	});

	it('carries no pager over to the next document', async () => {
		const { container, rerender } = render(SourceReader, {
			props: {
				source: null,
				doc: DOC,
				loadSource: async () => null,
				onClose: () => {},
				pdfLoader: threePages()
			}
		});
		await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());

		// The next document never finishes loading, so a pager on screen can only be the last one's.
		await rerender({
			doc: { sourceId: 'tap_va101', title: 'TAP - VA Benefits 101 (Resource Guide)' },
			pdfLoader: () => new Promise<PdfRuntime>(() => {})
		});
		await vi.waitFor(() => expect(shown(container)).toContain('Loading page 1 of the document'));
		expect(container.querySelector('.pager')).toBeNull();
	});

	// From every entry, an answer's included: the official site first, then the Documents area.
	it('links to all documents after the official site, and closes the reader on the way', () => {
		const onClose = vi.fn();
		const whole = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource: async () => null, onClose }
		});
		const answer = render(SourceReader, { props: { source: source(), onClose: () => {} } });
		flushSync();
		for (const { container } of [whole, answer]) {
			const links = [...container.querySelectorAll('.reader__link')];
			expect(links.map((a) => a.textContent?.trim())).toEqual([
				'View on the official site',
				'All documents'
			]);
			expect(links[1]?.getAttribute('href')).toBe('/documents');
		}
		(whole.container.querySelectorAll('.reader__link')[1] as HTMLAnchorElement).addEventListener(
			'click',
			(event) => event.preventDefault()
		);
		(whole.container.querySelectorAll('.reader__link')[1] as HTMLAnchorElement).click();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('links to the document itself on the official site', () => {
		const { container } = render(SourceReader, {
			props: { source: null, doc: DOC, loadSource: async () => null, onClose: () => {} }
		});
		flushSync();
		const link = container.querySelector('.reader__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(
			'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf'
		);
	});

	// A phone turned sideways is short: the parts pinned around the pages would leave the pages almost no room.
	// There the reader fills the screen, and the switch, the note and the foot scroll with the document; the title
	// bar and the page bar stay pinned. The frame's size is put back after each case.
	describe('on a short screen', () => {
		let size = { width: 0, height: 0 };
		beforeEach(() => {
			size = { width: window.innerWidth, height: window.innerHeight };
		});
		afterEach(async () => {
			await page.viewport(size.width, size.height);
		});

		const open = () =>
			render(SourceReader, {
				props: {
					source: null,
					doc: DOC,
					loadSource: async () => null,
					onClose: () => {},
					pdfLoader: threePages()
				}
			});

		it('fills the screen, pins the title bar and the page bar, and scrolls the rest with the foot first', async () => {
			await page.viewport(844, 390);
			const { container } = open();
			await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());

			const body = container.querySelector('.reader__body') as HTMLElement;
			// Close stays in reach: an iPhone has no Escape key.
			expect(body.contains(container.querySelector('.reader__head'))).toBe(false);
			for (const part of ['.reader__switch', '.reader__foot']) {
				expect(body.contains(container.querySelector(part))).toBe(true);
			}
			expect(body.contains(container.querySelector('.pager'))).toBe(false);
			// Save and the links come before the document, a short scroll away, so the keyboard runs Close, switch,
			// Save, links, document, page bar - and Shift+Tab from the page bar stays on the page.
			const foot = container.querySelector('.reader__foot') as Element;
			const doc = container.querySelector('.reader__doc') as Element;
			expect(foot.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			// Above the document, the foot's rule divides it from the document below. The app defines the rule's
			// colour globally; without it the border is dropped whole, so the test supplies it.
			container.style.setProperty('--color-border', 'rgb(1, 2, 3)');
			expect(getComputedStyle(foot).borderTopStyle).toBe('none');
			expect(getComputedStyle(foot).borderBottomStyle).toBe('solid');
			const dialog = container.querySelector('dialog.reader') as HTMLElement;
			expect(dialog.getBoundingClientRect().height).toBe(390);
			// The head keeps only the title, on one line.
			expect(getComputedStyle(container.querySelector('.reader__src') as Element).display).toBe(
				'none'
			);
			expect(
				getComputedStyle(container.querySelector('.reader__title') as Element).whiteSpace
			).toBe('nowrap');
		});

		// At 400% zoom the reader is short and narrow at once: the title wraps there rather than being cut, so it
		// can be read whole.
		it('wraps the title rather than cutting it on a screen both short and narrow', async () => {
			await page.viewport(320, 256);
			const { container } = open();
			const title = () => container.querySelector('.reader__title') as HTMLElement;
			await vi.waitFor(() => expect(title()).not.toBeNull());
			expect(getComputedStyle(title()).whiteSpace).toBe('normal');
			expect(title().scrollWidth).toBeLessThanOrEqual(title().clientWidth);
		});

		// The text lands on the cited passage, often far down; the line says why there is no page view.
		it("keeps a web page's line pinned under the title bar", async () => {
			await page.viewport(844, 390);
			const { container } = render(SourceReader, {
				props: { source: source(), onClose: () => {} }
			});
			flushSync();
			const body = container.querySelector('.reader__body') as HTMLElement;
			expect(container.querySelector('.reader__pin')).not.toBeNull();
			expect(body.contains(container.querySelector('.reader__pin'))).toBe(false);
		});

		it('keeps the head, the switch and the foot pinned on a screen tall enough', async () => {
			await page.viewport(1280, 800);
			const { container } = open();
			await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());

			const body = container.querySelector('.reader__body') as HTMLElement;
			for (const part of ['.reader__head', '.reader__switch', '.reader__foot']) {
				expect(body.contains(container.querySelector(part))).toBe(false);
			}
			expect(getComputedStyle(container.querySelector('.reader__src') as Element).display).not.toBe(
				'none'
			);
		});

		// Turning the phone builds the switch, the note and the foot again in their other place. Focus goes back to
		// the control that held it, so a keyboard or screen reader user keeps their place. The Save shows only once
		// it has read the device, so its focus comes back a moment later. The page view has landed first, as it has
		// when a user is reading; a landing that comes after the user moved focus is its own case. The reader is on
		// page 3 when the phone turns and stays there: on a short screen the control is above the pages in the
		// scroll, and giving it focus must not scroll the reader back to the top.
		const inBody = (c: Element) => c.querySelector('.reader__body .reader__foot') !== null;
		const landed = () =>
			vi.waitFor(() => expect(document.activeElement?.classList.contains('pdf__page')).toBe(true));
		const settle = () =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			);
		it.each([
			['the Page button', (c: Element) => c.querySelectorAll('.seg button')[0], false],
			['the Text button', (c: Element) => c.querySelectorAll('.seg button')[1], false],
			['the first link', (c: Element) => c.querySelectorAll('.reader__link')[0], false],
			['the second link', (c: Element) => c.querySelectorAll('.reader__link')[1], false],
			['the Save', (c: Element) => c.querySelector('.save'), false],
			['the line saying it is saved', (c: Element) => c.querySelector('.save__done'), true]
		])('gives focus back to %s when the screen turns, both ways', async (_name, find, held) => {
			await caches.delete(ASK_ASSET_CACHE);
			if (held) {
				const path = localDocumentPath(DOC.sourceId) ?? '';
				await (await caches.open(ASK_ASSET_CACHE)).put(path, new Response('pdf'));
			}
			try {
				await page.viewport(844, 800);
				const { container } = open();
				const body = container.querySelector('.reader__body') as HTMLElement;
				const number = () => (container.querySelector('.pager input') as HTMLInputElement).value;
				await landed();
				const third = container.querySelector('[data-page="3"]') as HTMLElement;
				body.scrollTop =
					third.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
				await vi.waitFor(() => expect(number()).toBe('3'));
				await vi.waitFor(() => expect(find(container)).toBeTruthy());
				(find(container) as HTMLElement).focus();
				expect(document.activeElement).toBe(find(container));

				await page.viewport(844, 390);
				await vi.waitFor(() => expect(inBody(container)).toBe(true));
				await vi.waitFor(() => expect(document.activeElement).toBe(find(container)));
				await settle();
				expect(number()).toBe('3');

				await page.viewport(844, 800);
				await vi.waitFor(() => expect(inBody(container)).toBe(false));
				await vi.waitFor(() => expect(document.activeElement).toBe(find(container)));
			} finally {
				await caches.delete(ASK_ASSET_CACHE);
			}
		});

		// The body has no room around the views here, and it clips: a focus ring drawn outside a view is cut off.
		// Each view draws its ring inside itself. Reached by the keys, as a user reaches it.
		it.each([
			['the pages', '.reader__doc', false],
			['the text', '.reader__text', true]
		])('draws the focus ring of %s inside it', async (_name, selector, onText) => {
			await page.viewport(844, 390);
			const { container } = render(SourceReader, {
				props: {
					source: null,
					doc: DOC,
					loadSource: async () => null,
					onClose: () => {},
					pdfLoader: threePages()
				}
			});
			container.style.setProperty('--color-accent', 'rgb(1, 2, 3)');
			await vi.waitFor(() => expect(container.querySelector('.pager')).not.toBeNull());
			if (onText) seg(container, 'Text')?.click();
			const region = container.querySelector(selector) as HTMLElement;
			await vi.waitFor(() => expect(region.hidden).toBe(false));
			(container.querySelectorAll('.reader__link')[1] as HTMLElement).focus();
			await userEvent.keyboard('{Tab}');

			expect(document.activeElement).toBe(region);
			expect(getComputedStyle(region).outlineStyle).toBe('solid');
			expect(getComputedStyle(region).outlineOffset).toBe('-2px');
		});

		// The foot comes before the pages here, so Shift+Tab from the page bar goes back to the pages, not to a
		// control far above them in the scroll, and the reader stays where they were.
		it('takes Shift+Tab from the page bar to the pages, leaving the scroll where it was', async () => {
			await page.viewport(844, 390);
			const { container } = open();
			await landed();
			const body = container.querySelector('.reader__body') as HTMLElement;
			const second = container.querySelector('[data-page="2"]') as HTMLElement;
			body.scrollTop =
				second.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
			await settle();
			const before = body.scrollTop;
			(container.querySelector('.pager input') as HTMLElement).focus();

			await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
			expect(document.activeElement).toBe(container.querySelector('.reader__doc'));
			await settle();
			expect(body.scrollTop).toBe(before);
		});

		// A web page has no Save, so nothing shows late: its link has focus back as soon as it is built again.
		it("gives focus back to a web page's link when the screen turns", async () => {
			await page.viewport(844, 800);
			const { container } = render(SourceReader, {
				props: { source: source(), onClose: () => {} }
			});
			const link = () => container.querySelectorAll('.reader__link')[1];
			await vi.waitFor(() => expect(link()).toBeDefined());
			(link() as HTMLElement).focus();

			await page.viewport(844, 390);
			await vi.waitFor(() => expect(inBody(container)).toBe(true));
			await vi.waitFor(() => expect(document.activeElement).toBe(link()));
		});

		// The Save reads the device before it shows. A user who moves focus on in that moment stays there.
		it('leaves focus where the user moved it before the Save showed again', async () => {
			await caches.delete(ASK_ASSET_CACHE);
			await page.viewport(844, 800);
			const { container } = open();
			await landed();
			await vi.waitFor(() => expect(container.querySelector('.save')).not.toBeNull());
			(container.querySelector('.save') as HTMLElement).focus();
			let letRead = () => {};
			const reading = new Promise<void>((resolve) => (letRead = resolve));
			const has = vi.spyOn(caches, 'has').mockImplementation(async () => {
				await reading;
				return false;
			});
			try {
				await page.viewport(844, 390);
				await vi.waitFor(() => expect(inBody(container)).toBe(true));
				const close = container.querySelector('.reader__close') as HTMLElement;
				close.focus();
				letRead();
				await vi.waitFor(() => expect(container.querySelector('.save')).not.toBeNull());
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(document.activeElement).toBe(close);
			} finally {
				letRead();
				has.mockRestore();
			}
		});
	});
});
