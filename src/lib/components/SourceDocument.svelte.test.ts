import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import SourceDocument from './SourceDocument.svelte';
import { selectAnswer } from '$lib/ask/answer/select-answer';
import type { PdfContentItem } from '$lib/sources/pdf-text';
import type { PdfDocument, PdfRuntime } from '$lib/sources/pdf-runtime';
import { LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';

/** A text run at (x, baseline y) in page units, the shape the reader emits. */
function run(str: string, x: number, y: number): PdfContentItem {
	return { str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 };
}

// A passage of 16 one-line sentences. The answer's quote is its opening sentences up to the word budget,
// so the quote is strictly shorter than the passage - a view that dropped the quote would tint all 16.
const SENTENCES = Array.from(
	{ length: 16 },
	(_, i) => `Sentence ${i} explains one more rule about filing a claim with VA.`
);
const PASSAGE = SENTENCES.join(' ');
const WITH_PASSAGE: PdfContentItem[] = SENTENCES.map((s, i) => run(s, 40, 760 - i * 15));
const FILLER: PdfContentItem[] = [run('Unrelated page body text.', 40, 720)];

function fakeRuntime(pages: PdfContentItem[][], options: { fail?: boolean } = {}) {
	const calls = { getDocument: 0 };
	const doc: PdfDocument = {
		numPages: pages.length,
		async getPage(n) {
			return {
				getViewport: ({ scale }) => ({
					width: 600 * scale,
					height: 800 * scale,
					transform: [scale, 0, 0, -scale, 0, 800 * scale]
				}),
				render: () => ({ promise: Promise.resolve(), cancel() {} }),
				getTextContent: async () => ({ items: pages[n - 1] ?? [] }),
				cleanup() {}
			};
		}
	};
	const runtime: PdfRuntime = {
		getDocument: () => {
			calls.getDocument += 1;
			return {
				promise: options.fail ? Promise.reject(new Error('E_TEST_LOAD')) : Promise.resolve(doc),
				destroy: async () => {}
			};
		}
	};
	return { loader: async () => runtime, calls };
}

function props(loader: () => Promise<PdfRuntime>, over: Record<string, unknown> = {}) {
	return {
		path: '/docs/doc.pdf',
		bytes: 6_900_000,
		title: 'VA Benefits Guide',
		page: 3,
		anchor: PASSAGE,
		passageText: PASSAGE,
		onfallback: vi.fn(),
		onshowtext: vi.fn(),
		isSaved: async () => true,
		isOnline: () => true,
		held: async () => [] as string[],
		loader,
		...over
	};
}

const text = (container: Element) => container.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (container: Element, label: string) =>
	[...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('SourceDocument', () => {
	// Viewing keeps nothing, so there is nothing to ask first: online, a document not saved opens at once, and
	// the loading box states its size while the file arrives.
	it('opens the page at once, online, when the document is not saved, stating its size', async () => {
		const pending = () => new Promise<PdfRuntime>(() => {});
		const { container } = render(SourceDocument, {
			props: props(pending, { isSaved: async () => false })
		});

		await vi.waitFor(() =>
			expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
				'Loading page 3 of the document (6.9 MB)...'
			)
		);
		expect(container.querySelector('button')).toBeNull();
	});

	it('fetches a document not saved as soon as it opens, online', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, {
			props: props(loader, { isSaved: async () => false })
		});

		await vi.waitFor(() => expect(calls.getDocument).toBe(1));
		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
	});

	it('opens straight to the page, without asking, when the document is already saved', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('.pdf__page')).not.toBeNull());
		expect(button(container, 'Open page 3')).toBeUndefined();
	});

	// Known before trying: a load that must fail offline would only delay the text the user can have now.
	it('falls back to the text, offline, when the document was never saved', async () => {
		const onfallback = vi.fn();
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, {
			props: props(loader, { isSaved: async () => false, isOnline: () => false, onfallback })
		});

		await vi.waitFor(() => expect(onfallback).toHaveBeenCalledWith('offline'));
		expect(button(container, 'Open page 3')).toBeUndefined();
		expect(calls.getDocument).toBe(0);
	});

	// The document was saved, then updated: its older copy is held and the new version is not. Offline, that is
	// what the reader says, not that the document was never saved. Another document held says nothing of this one.
	it('falls back to the text, offline, saying the new version is not saved when an older copy is', async () => {
		const onfallback = vi.fn();
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		render(SourceDocument, {
			props: props(loader, {
				path: '/docs/tap_vet_centers.1dcfd966.pdf',
				isSaved: async () => false,
				isOnline: () => false,
				held: async () => ['/docs/tap_va101.5e2c9a1b.pdf', '/docs/tap_vet_centers.0badc0de.pdf'],
				onfallback
			})
		});

		await vi.waitFor(() => expect(onfallback).toHaveBeenCalledWith('updated'));
		expect(calls.getDocument).toBe(0);
	});

	// The reader moved to another document while the device was still being read for this one: what the read
	// finds belongs to a document no longer shown.
	it('says nothing of a document it moved on from while it read the device', async () => {
		const onfallback = vi.fn();
		let read: ((paths: string[]) => void) | undefined;
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { rerender } = render(SourceDocument, {
			props: props(loader, {
				isSaved: async () => false,
				isOnline: () => false,
				held: () => new Promise<string[]>((resolve) => (read = resolve)),
				onfallback
			})
		});
		await vi.waitFor(() => expect(read).toBeDefined());

		await rerender({ path: '/docs/other.pdf', page: 1, isSaved: async () => true });
		read?.(['/docs/doc.0badc0de.pdf']);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onfallback).not.toHaveBeenCalled();
	});

	it('says only that the document is not saved when what is held is another document', async () => {
		const onfallback = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		render(SourceDocument, {
			props: props(loader, {
				path: '/docs/tap_vet_centers.1dcfd966.pdf',
				isSaved: async () => false,
				isOnline: () => false,
				held: async () => ['/docs/tap_va101.5e2c9a1b.pdf'],
				onfallback
			})
		});

		await vi.waitFor(() => expect(onfallback).toHaveBeenCalledWith('offline'));
	});

	it('falls back to the text when the document cannot be loaded', async () => {
		const onfallback = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { fail: true });
		render(SourceDocument, { props: props(loader, { onfallback }) });

		await vi.waitFor(() => expect(onfallback).toHaveBeenCalledWith('failed'));
	});

	// The page number lives in the reader's page bar, so the held line says only what the pages are, once.
	it('says once, at the top, that the pages are a copy of the official document', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
		expect(
			text(container).split('A copy of the official document, without its pictures.')
		).toHaveLength(2);
		expect(container.firstElementChild?.textContent?.trim()).toBe(
			'A copy of the official document, without its pictures.'
		);
		expect(text(container)).not.toContain('Page 3 of 3');
	});

	// Three guides kept the pictures whose own metadata states Public Domain. Their line says only most of the
	// pictures are gone; every other document's says they all are.
	it('says a guide that kept some of its pictures is without most of them', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, {
			props: props(loader, { path: LOCAL_DOCUMENTS['tap_va_benefits_guide'] })
		});

		await vi.waitFor(() => expect(container.querySelector('.doc__held')).not.toBeNull());
		expect(container.querySelector('.doc__held')?.textContent?.trim()).toBe(
			'A copy of the official document, without most of its pictures.'
		);
	});

	it('says a guide that kept none of its pictures is without them', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, {
			props: props(loader, { path: LOCAL_DOCUMENTS['tap_vet_centers'] })
		});

		await vi.waitFor(() => expect(container.querySelector('.doc__held')).not.toBeNull());
		expect(container.querySelector('.doc__held')?.textContent?.trim()).toBe(
			'A copy of the official document, without its pictures.'
		);
	});

	it('marks the quote the answer showed, not the whole passage', async () => {
		expect(selectAnswer(PASSAGE).split('. ').length).toBeLessThan(SENTENCES.length);
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
		const quoteLines = selectAnswer(PASSAGE).split('. ').length;
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(quoteLines);
	});

	// The real case: cited as page 19, found on page 20. The scroll holds the whole document, so the reader
	// lands on the passage itself and a note keeps the citation honest by naming both pages.
	it('lands on a passage found on another page, and notes both pages', async () => {
		const onnote = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, { props: props(loader, { onnote }) });

		await vi.waitFor(() =>
			expect(onnote).toHaveBeenLastCalledWith({ kind: 'elsewhere', cited: 3, found: 4 })
		);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('[data-page="4"]'))
		);
		expect(container.querySelectorAll('[data-page="4"] .pdf__mark').length).toBeGreaterThan(0);
		expect(container.querySelector('.doc__notice')).toBeNull();
	});

	// The reader decides whether the landing may take focus - the user may have moved it while the document
	// loaded - and the page view is told.
	it('lands without taking focus when the reader says it may not', async () => {
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		try {
			elsewhere.focus();
			const onview = vi.fn();
			const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE, FILLER]);
			render(SourceDocument, { props: props(loader, { onview, mayFocus: () => false }) });

			await vi.waitFor(() => expect(onview).toHaveBeenLastCalledWith({ page: 3, pages: 4 }));
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});

	it('notes a passage found nowhere as unmarked, and stays on the cited page', async () => {
		const onnote = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(SourceDocument, { props: props(loader, { onnote }) });

		await vi.waitFor(() => expect(onnote).toHaveBeenLastCalledWith({ kind: 'unmarked' }));
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('[data-page="3"]'))
		);
	});

	// A document opened from the Documents list has no cited passage: it opens at page 1 and says nothing
	// about a passage, rather than reporting one it was never asked to find.
	it('says nothing about a passage when the document was opened without one', async () => {
		const onnote = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(SourceDocument, {
			props: props(loader, { page: 1, anchor: '', passageText: '', cited: false, onnote })
		});

		await vi.waitFor(() =>
			expect(text(container)).toContain('A copy of the official document, without its pictures.')
		);
		await vi.waitFor(() => expect(container.querySelector('[data-page="3"]')).not.toBeNull());
		expect(onnote.mock.calls.every(([note]) => note === null)).toBe(true);
	});

	// The reader's pager needs the page on screen and how many there are.
	it('reports the page on screen and the page count once the page is located', async () => {
		const onview = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE, FILLER]);
		render(SourceDocument, { props: props(loader, { onview }) });
		await vi.waitFor(() => expect(onview).toHaveBeenLastCalledWith({ page: 3, pages: 4 }));
	});

	it('scrolls to a page the reader asks for, and reports it', async () => {
		const onview = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE, FILLER]);
		const { rerender } = render(SourceDocument, { props: props(loader, { onview }) });
		await vi.waitFor(() => expect(onview).toHaveBeenLastCalledWith({ page: 3, pages: 4 }));

		await rerender({ request: { page: 1 } });
		await vi.waitFor(() => expect(onview).toHaveBeenLastCalledWith({ page: 1, pages: 4 }));
	});

	// The note is about where the answer's passage is. Scrolling elsewhere does not change or repeat it.
	it('notes the passage once, however the reader moves through the document', async () => {
		const onnote = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER, WITH_PASSAGE]);
		const { rerender } = render(SourceDocument, { props: props(loader, { onnote }) });
		await vi.waitFor(() =>
			expect(onnote).toHaveBeenLastCalledWith({ kind: 'elsewhere', cited: 3, found: 4 })
		);
		const calls = onnote.mock.calls.length;

		await rerender({ request: { page: 1 } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(onnote.mock.calls.length).toBe(calls);
	});

	it('notes nothing when the passage is marked on its cited page', async () => {
		const onnote = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(SourceDocument, { props: props(loader, { onnote }) });

		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
		await vi.waitFor(() => expect(onnote).toHaveBeenLastCalledWith(null));
		expect(onnote.mock.calls.every(([note]) => note === null)).toBe(true);
	});
});
