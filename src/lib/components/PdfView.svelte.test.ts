import { render } from 'vitest-browser-svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import PdfView from './PdfView.svelte';
import { searchPages } from '$lib/sources/highlight-match';
import type { PdfContentItem } from '$lib/sources/pdf-text';
import type { PdfDocument, PdfLoadingTask, PdfRuntime } from '$lib/sources/pdf-runtime';
import { pageInView } from '$lib/sources/scroll-pages';

const PASSAGE = 'The notice explains who may apply and what evidence is required.';

/** A text run at (x, baseline y) in page units, the shape the reader emits. */
function run(str: string, x: number, y: number): PdfContentItem {
	return { str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 };
}

/** A page carrying the passage, split across runs the way a real text layer splits it. */
const WITH_PASSAGE: PdfContentItem[] = [
	run('Lead in text.', 40, 740),
	run('The notice explains who may apply', 40, 720),
	{ type: 'beginMarkedContent' },
	run('and what evidence is required.', 40, 705),
	run('Trailing text.', 40, 690)
];

const FILLER: PdfContentItem[] = [run('Unrelated page body text.', 40, 720)];

// A passage over four lines whose quote is its first two. Sized so the quote is strictly smaller than the
// passage: were they equal, a view that ignored the quote would pass every test below.
const LONG_LINES = [
	'The notice explains who may apply for the benefit.',
	'It lists the evidence each applicant must provide.',
	'Claims are reviewed in the order they arrive.',
	'A decision letter follows within ninety days.'
];
const LONG_PASSAGE = LONG_LINES.join(' ');
const QUOTE = LONG_LINES.slice(0, 2).join(' ');
const WITH_LONG_PASSAGE: PdfContentItem[] = [
	run('Lead in text.', 40, 760),
	...LONG_LINES.map((line, i) => run(line, 40, 740 - i * 15)),
	run('Trailing text.', 40, 660)
];

/** A drawn element's box, read back from the inline style the view positions it with. */
function box(el: Element | null | undefined) {
	const style = (el as HTMLElement | null | undefined)?.style;
	return { top: parseFloat(style?.top ?? 'NaN'), height: parseFloat(style?.height ?? 'NaN') };
}

/**
 * A stand-in for the PDF runtime. It satisfies the same structural contract the real library is
 * type-checked against, and records which pages were fetched and rendered.
 */
function fakeRuntime(
	pages: PdfContentItem[][],
	options: {
		fail?: boolean;
		hold?: Promise<void>;
		holdDocument?: Promise<void>;
		// Every page's draw waits on this before it ends.
		holdRender?: Promise<void>;
		// Pages whose first draw fails.
		failRender?: number[];
		// A page's natural [width, height]; 600 x 800 unless given, so a landscape page can differ.
		sizes?: Record<number, [number, number]>;
		// Pages the library cannot hand back: asking for one always fails.
		failGetPage?: number[];
	} = {}
) {
	const calls = {
		getPage: [] as number[],
		render: [] as number[],
		text: [] as number[],
		cleanup: [] as number[],
		getDocument: [] as unknown[],
		tasks: [] as PdfLoadingTask[],
		destroyed: 0
	};
	const failing = new Set(options.failRender);
	const doc: PdfDocument = {
		numPages: pages.length,
		async getPage(n) {
			calls.getPage.push(n);
			if (options.failGetPage?.includes(n)) throw new Error('E_TEST_PAGE');
			const [width, height] = options.sizes?.[n] ?? [600, 800];
			return {
				getViewport: ({ scale }) => ({
					width: width * scale,
					height: height * scale,
					transform: [scale, 0, 0, -scale, 0, height * scale]
				}),
				render: () => {
					calls.render.push(n);
					if (failing.delete(n)) {
						return { promise: Promise.reject(new Error('E_TEST_RENDER')), cancel() {} };
					}
					// As the library does, a draw cancelled before it ends rejects.
					let cancel = () => {};
					const promise = new Promise<void>((resolve, reject) => {
						cancel = () => reject(new Error('E_TEST_CANCELLED'));
						void (options.holdRender ?? Promise.resolve()).then(resolve);
					});
					return { promise, cancel: () => cancel() };
				},
				getTextContent: async () => {
					calls.text.push(n);
					return { items: pages[n - 1] ?? [] };
				},
				cleanup() {
					calls.cleanup.push(n);
				}
			};
		}
	};
	const runtime: PdfRuntime = {
		getDocument: (source) => {
			calls.getDocument.push(source);
			const task: PdfLoadingTask = {
				promise: options.fail
					? Promise.reject(new Error('E_TEST_LOAD'))
					: (options.holdDocument ?? Promise.resolve()).then(() => doc),
				destroy: async () => {
					calls.destroyed += 1;
				}
			};
			calls.tasks.push(task);
			return task;
		}
	};
	const loader = async () => {
		await options.hold;
		return runtime;
	};
	return { loader, calls };
}

// The reader's body: a box of fixed height that scrolls, which the page stack is measured and drawn against.
const scrollers: HTMLElement[] = [];
afterEach(() => {
	for (const el of scrollers.splice(0)) el.remove();
});
function scroller(height = 600, width = 300): HTMLElement {
	const el = document.createElement('div');
	el.style.cssText = `height: ${height}px; width: ${width}px; overflow-y: auto;`;
	document.body.appendChild(el);
	scrollers.push(el);
	return el;
}

/** Wait out `count` animation frames: long enough for a scroll to be reported and measured. */
function frames(count: number): Promise<void> {
	return new Promise((resolve) =>
		count === 0 ? resolve() : requestAnimationFrame(() => void frames(count - 1).then(resolve))
	);
}

/** A page's top in its scroller's content, as scrollTop counts it. */
function topIn(el: Element, box: HTMLElement): number {
	return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

function props(loader: () => Promise<PdfRuntime>, over: Record<string, unknown> = {}) {
	return {
		url: '/docs/doc.pdf',
		page: 3,
		anchor: PASSAGE,
		title: 'VA Benefits Guide',
		loader,
		...over
	};
}

describe('PdfView', () => {
	it('announces that the page is loading until it has rendered', async () => {
		let release!: () => void;
		const hold = new Promise<void>((resolve) => (release = resolve));
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { hold });
		const { container } = render(PdfView, { props: props(loader) });

		expect(container.querySelector('[role="status"]')?.textContent).toMatch(/loading page 3/i);
		release();
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
	});

	it('names every page as one image, the page carrying the passage as marked', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(calls.render).toContain(3));
		// Read once the page is ready: the name says whether a passage is marked, which is known only then.
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		// One image per page, so a screen reader announces each page once - not once for the wrapper and
		// again for the canvas inside it.
		expect(
			[...container.querySelectorAll('[role="img"]')].map((el) => el.getAttribute('aria-label'))
		).toEqual([
			'Page 1 of VA Benefits Guide',
			'Page 2 of VA Benefits Guide',
			'Page 3 of VA Benefits Guide, cited passage marked'
		]);
		const canvases = [...container.querySelectorAll('canvas')];
		expect(canvases).toHaveLength(3);
		expect(canvases.every((canvas) => canvas.getAttribute('aria-hidden') === 'true')).toBe(true);
	});

	it('names the page without claiming a mark when none is drawn', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelector('[data-page="3"]')?.getAttribute('aria-label')).toBe(
			'Page 3 of VA Benefits Guide'
		);
	});

	// A single status line would make the modal jump from one line to a full page when the render lands.
	it('holds the page shape while loading, stating the page and the document size', async () => {
		let release!: () => void;
		const hold = new Promise<void>((resolve) => (release = resolve));
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { hold });
		const { container } = render(PdfView, { props: props(loader, { bytes: 6_900_000 }) });

		const status = container.querySelector('[role="status"]') as HTMLElement;
		expect(status.textContent?.trim()).toBe('Loading page 3 of the document (6.9 MB)...');
		expect(getComputedStyle(status).aspectRatio).toBe('1 / 1.294');
		release();
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
	});

	// The box is a page tall, so a line centred in it starts below the fold on a phone. It sits at the top.
	it('states the loading line at the top of the page-shaped box, where it is in view', () => {
		const hold = new Promise<void>(() => {});
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { hold });
		const { container } = render(PdfView, { props: props(loader, { bytes: 6_900_000 }) });

		const status = container.querySelector('[role="status"]') as HTMLElement;
		const content = document.createRange();
		content.selectNodeContents(status);
		const box = status.getBoundingClientRect();
		expect(box.height).toBeGreaterThan(200);
		expect(content.getBoundingClientRect().top - box.top).toBeLessThan(box.height / 4);
	});

	it('states no size, and draws no bar, while loading when none is given', () => {
		const hold = new Promise<void>(() => {});
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { hold });
		const { container } = render(PdfView, { props: props(loader) });

		expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
			'Loading page 3 of the document...'
		);
		expect(container.querySelector('progress')).toBeNull();
	});

	// The page waits for the whole file (the host ignores byte ranges), so a 22 MB guide on a slow connection
	// needs to show it is moving. The host need not send a length, so the bar measures against the known size.
	it('shows how much of the file has arrived while it loads, and drops the bar once ready', async () => {
		let release!: () => void;
		const holdDocument = new Promise<void>((resolve) => (release = resolve));
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { holdDocument });
		const { container } = render(PdfView, { props: props(loader, { bytes: 6_900_000 }) });

		await vi.waitFor(() => expect(calls.tasks).toHaveLength(1));
		const report = calls.tasks[0]?.onProgress;
		expect(typeof report).toBe('function');
		(report as (progress: { loaded: number; total: number }) => void)({
			loaded: 2_300_000,
			total: 0
		});
		await vi.waitFor(() =>
			expect((container.querySelector('progress') as HTMLProgressElement | null)?.value).toBe(
				2_300_000
			)
		);
		expect((container.querySelector('progress') as HTMLProgressElement).max).toBe(6_900_000);

		release();
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelector('progress')).toBeNull();
	});

	// A connection that is up but silent would hold the loading box forever. Nothing arriving for a while is a
	// failed load: the reader falls back to its text, and the download is stopped.
	it('gives the download up as failed when nothing arrives for a while', async () => {
		const onfail = vi.fn();
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], {
			holdDocument: new Promise<void>(() => {})
		});
		const { container } = render(PdfView, {
			props: props(loader, { bytes: 6_900_000, onfail, stallAfter: 100 })
		});

		await vi.waitFor(() => expect(onfail).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[role="status"]')).toBeNull();
		expect(calls.destroyed).toBe(1);
	});

	it('keeps waiting while the download is still arriving', async () => {
		let release!: () => void;
		const holdDocument = new Promise<void>((resolve) => (release = resolve));
		const onfail = vi.fn();
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { holdDocument });
		const { container } = render(PdfView, {
			props: props(loader, { bytes: 6_900_000, onfail, stallAfter: 300 })
		});
		await vi.waitFor(() => expect(calls.tasks).toHaveLength(1));
		const report = calls.tasks[0]?.onProgress as (progress: {
			loaded: number;
			total: number;
		}) => void;

		// Twelve reports 60 ms apart: more than twice the stall in all, and never a stall between two of them.
		for (let i = 1; i <= 12; i++) {
			report({ loaded: i * 100_000, total: 0 });
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
		expect(onfail).not.toHaveBeenCalled();
		release();
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(onfail).not.toHaveBeenCalled();
		expect(container.querySelectorAll('.pdf__page')).toHaveLength(3);
		// Once the document is here, the wait is over: it is never given up later as stalled.
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(calls.destroyed).toBe(0);
	});

	it('stops waiting for the download when it is closed', async () => {
		const onfail = vi.fn();
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], {
			holdDocument: new Promise<void>(() => {})
		});
		const { unmount } = render(PdfView, {
			props: props(loader, { bytes: 6_900_000, onfail, stallAfter: 100 })
		});
		await vi.waitFor(() => expect(calls.tasks).toHaveLength(1));

		unmount();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(calls.destroyed).toBe(1);
		expect(onfail).not.toHaveBeenCalled();
	});

	// Closing the reader unmounts the view; a download it no longer needs must not run on in the background.
	it('stops the download when it is closed before the document arrives', async () => {
		const holdDocument = new Promise<void>(() => {});
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { holdDocument });
		const { unmount } = render(PdfView, { props: props(loader, { bytes: 6_900_000 }) });

		await vi.waitFor(() => expect(calls.tasks).toHaveLength(1));
		expect(calls.destroyed).toBe(0);
		unmount();
		expect(calls.destroyed).toBe(1);
	});

	// The text view lands focus on the cited passage; the page view lands it on the page, so a keyboard or
	// screen reader user arrives where a sighted user's eye does.
	it('lands focus on the cited page once it is ready', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		const pageEl = container.querySelector('[data-page="3"]');
		expect(pageEl?.getAttribute('tabindex')).toBe('-1');
		await vi.waitFor(() => expect(document.activeElement).toBe(pageEl));
	});

	// A saved document is one whole file that the service worker hands back to any later request for the url;
	// a range read of it would be misread, and the host ignores ranges anyway. So the document is fetched whole.
	it('fetches the document whole, never in byte ranges', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		render(PdfView, { props: props(loader) });

		await vi.waitFor(() =>
			expect(calls.getDocument).toEqual([
				{ url: '/docs/doc.pdf', disableRange: true, disableStream: true }
			])
		);
	});

	it('marks the cited passage when it sits on the rendered page', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(PdfView, { props: props(loader) });

		// The passage spans two lines of the page, so it is two bands, not one and not four.
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__mark')).toHaveLength(2));
	});

	// A page that fails to draw keeps its placeholder. It claims no mark: none is drawn over the empty box, and
	// its name does not say a passage is marked on it.
	it('claims no mark on a page that failed to draw', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE], { failRender: [3] });
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(calls.render).toContain(3));
		const page = container.querySelector('[data-page="3"]') as HTMLElement;
		await vi.waitFor(() =>
			expect(page.getAttribute('aria-label')).toBe('Page 3 of VA Benefits Guide')
		);
		expect(page.querySelectorAll('.pdf__mark')).toHaveLength(0);
		expect(page.querySelector('.pdf__bar')).toBeNull();
	});

	it('renders the page without marks when the passage is not in the document', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(calls.render).toContain(3));
		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(0);
	});

	// Measured on the real corpus: about one located passage in nine sits wholly on a page other than the
	// cited one. The marks go where the passage is, never onto the cited page in its place.
	it('marks a passage found only on the next page there, and nothing on the cited page', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('[data-page="3"] .pdf__mark')).toHaveLength(0);
		expect(container.querySelectorAll('[data-page="4"] .pdf__mark')).toHaveLength(2);
		// Each mark lies on its own page, not merely inside its page's element.
		const sheet = (
			container.querySelector('[data-page="4"]') as HTMLElement
		).getBoundingClientRect();
		for (const mark of container.querySelectorAll('[data-page="4"] .pdf__mark')) {
			const at = mark.getBoundingClientRect();
			expect(at.top).toBeGreaterThanOrEqual(sheet.top);
			expect(at.bottom).toBeLessThanOrEqual(sheet.bottom);
		}
	});

	// Drawing a page fetches it too, so the search is measured by the text it reads.
	it('reads the text of exactly the pages the search may read', async () => {
		const { loader, calls } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE, FILLER, FILLER, FILLER]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect([...new Set(calls.text)].sort((a, b) => a - b)).toEqual(searchPages(3, 6));
	});

	// The reader falls back to its text view on failure, so the view must say it failed rather than leave
	// an empty canvas or a spinner that never ends.
	it('reports a load failure and shows no page', async () => {
		const onfail = vi.fn();
		const { loader } = fakeRuntime([WITH_PASSAGE], { fail: true });
		const { container } = render(PdfView, { props: props(loader, { page: 1, onfail }) });

		await vi.waitFor(() => expect(onfail).toHaveBeenCalledTimes(1));
		expect(container.querySelector('.pdf__page')).toBeNull();
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	// A canvas is opaque to a screen reader. The passage it highlights is the content that was cited, so it
	// is exposed as text alongside the image rather than left locked inside the pixels.
	it('exposes the cited passage as text once the page is ready', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		const { container } = render(PdfView, { props: props(loader) });

		await vi.waitFor(() =>
			expect(container.querySelector('.pdf__passage')?.textContent).toContain(PASSAGE)
		);
	});

	// A document opened whole cites nothing. A line naming a cited passage would then be read out as
	// "Cited passage:" followed by nothing, a claim with no passage behind it.
	it('says nothing of a cited passage when there is none', async () => {
		const onlocate = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, anchor: '', onlocate })
		});

		// The view reports as it becomes ready, which is when the line would be drawn.
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(container.querySelectorAll('.pdf__page')).toHaveLength(3);
		expect(container.querySelector('.pdf__passage')).toBeNull();
	});

	// The reader tints what the answer QUOTED - the words the user just read - and bars the whole passage,
	// so the eye lands on the quote while the page still shows where the source runs.
	it('tints only the quoted lines when the quote sits inside the passage', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const { container } = render(PdfView, {
			props: props(loader, { anchor: LONG_PASSAGE, quote: QUOTE })
		});

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(2);
	});

	it('bars the whole passage, from its first line to its last, while the tint covers the quote', async () => {
		const plain = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const whole = render(PdfView, { props: props(plain.loader, { anchor: LONG_PASSAGE }) });
		await vi.waitFor(() => expect(whole.container.querySelectorAll('.pdf__mark')).toHaveLength(4));
		const lines = [...whole.container.querySelectorAll('.pdf__mark')].map(box);
		const first = lines[0];
		const last = lines[3];
		whole.unmount();

		const quoted = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const { container } = render(PdfView, {
			props: props(quoted.loader, { anchor: LONG_PASSAGE, quote: QUOTE })
		});
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__bar')).toHaveLength(1));
		const bar = box(container.querySelector('.pdf__bar'));

		expect(bar.top).toBeCloseTo(first?.top ?? NaN, 3);
		expect(bar.top + bar.height).toBeCloseTo((last?.top ?? NaN) + (last?.height ?? NaN), 3);
	});

	it('tints the whole passage when the quote cannot be found', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const { container } = render(PdfView, {
			props: props(loader, {
				anchor: LONG_PASSAGE,
				quote: 'Words that appear nowhere on this page or any other.'
			})
		});

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(4);
	});

	// A quote matched outside its own passage would point the eye at text the answer did not come from.
	it('tints the whole passage when the quote is found only outside it', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const { container } = render(PdfView, {
			props: props(loader, { anchor: LONG_PASSAGE, quote: 'Lead in text.' })
		});

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(4);
	});

	it('draws neither a bar nor a mark when the passage is not on the page', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		const { container } = render(PdfView, {
			props: props(loader, { anchor: LONG_PASSAGE, quote: QUOTE })
		});

		await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
		expect(container.querySelectorAll('.pdf__mark')).toHaveLength(0);
		expect(container.querySelectorAll('.pdf__bar')).toHaveLength(0);
	});

	// The reader says so when a page carries no mark, naming where the passage actually is - so the view
	// reports what it found rather than leaving the reader to guess from an empty page.
	it('reports a marked passage on the cited page, and the page count', async () => {
		const onlocate = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_PASSAGE]);
		render(PdfView, { props: props(loader, { onlocate }) });

		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(onlocate).toHaveBeenCalledWith({ marked: true, foundOn: [3], pageCount: 3 });
	});

	it('reports a passage found only on the next page as unmarked, naming that page', async () => {
		const onlocate = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER, WITH_PASSAGE]);
		render(PdfView, { props: props(loader, { onlocate }) });

		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(onlocate).toHaveBeenCalledWith({ marked: false, foundOn: [4], pageCount: 4 });
	});

	it('reports a passage found nowhere as unmarked, on no page', async () => {
		const onlocate = vi.fn();
		const { loader } = fakeRuntime([FILLER, FILLER, FILLER]);
		render(PdfView, { props: props(loader, { onlocate }) });

		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(onlocate).toHaveBeenCalledWith({ marked: false, foundOn: [], pageCount: 3 });
	});

	it('exposes the quote, not the whole passage, as text when the quote is what is tinted', async () => {
		const { loader } = fakeRuntime([FILLER, FILLER, WITH_LONG_PASSAGE]);
		const { container } = render(PdfView, {
			props: props(loader, { anchor: LONG_PASSAGE, quote: QUOTE })
		});

		await vi.waitFor(() => expect(container.querySelector('.pdf__passage')).not.toBeNull());
		const text = container.querySelector('.pdf__passage')?.textContent ?? '';
		expect(text).toContain(QUOTE);
		expect(text).not.toContain(LONG_LINES[2]);
	});
});

// The whole document scrolls in the reader's body. Twelve pages are far taller than the 600 px view, so some
// pages are near it and some are not - the case a single-page view never had.
describe('PdfView, the whole document', () => {
	const TWELVE = (): PdfContentItem[][] => Array.from({ length: 12 }, () => FILLER);
	const pageAt = (container: Element, n: number) =>
		container.querySelector(`[data-page="${n}"]`) as HTMLElement;
	// A line above the first page, where the reader places the one saying what the pages are.
	const above = () => {
		const el = document.createElement('p');
		el.style.cssText = 'height: 40px; margin: 0;';
		return el;
	};
	// How far down page n the top of the view is, as a share of the page's height.
	const placeOn = (container: Element, box: HTMLElement, n: number) =>
		(box.scrollTop - topIn(pageAt(container, n), box)) / pageAt(container, n).clientHeight;
	// The page in view by the reader's own rule, read from the pages as laid out now.
	const inView = (container: Element, box: HTMLElement) =>
		pageInView(
			[...container.querySelectorAll('[data-page]')].map((el) => topIn(el, box)),
			box.scrollTop,
			box.clientHeight
		);

	it('draws the pages near the view, holding every other page to its size with its number', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });

		await vi.waitFor(() => expect(calls.render).toContain(2));
		expect(container.querySelectorAll('.pdf__page')).toHaveLength(12);
		expect(calls.render).not.toContain(12);
		expect(pageAt(container, 12).getBoundingClientRect().height).toBeCloseTo(
			pageAt(container, 1).getBoundingClientRect().height,
			0
		);
		expect(pageAt(container, 12).textContent).toContain('Page 12');
	});

	it('releases a page scrolled far away, keeping its size, and draws the one scrolled to', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));
		await vi.waitFor(() => expect(calls.render).toContain(1));
		const firstHeight = pageAt(container, 1).getBoundingClientRect().height;
		expect(
			(pageAt(container, 1).querySelector('canvas') as HTMLCanvasElement).width
		).toBeGreaterThan(0);

		box.scrollTop = box.scrollHeight;
		await vi.waitFor(() => expect(calls.render).toContain(12));
		await vi.waitFor(() =>
			expect((pageAt(container, 1).querySelector('canvas') as HTMLCanvasElement).width).toBe(0)
		);
		expect(pageAt(container, 1).getBoundingClientRect().height).toBeCloseTo(firstHeight, 0);
	});

	it('marks a page again once a later draw of it succeeds', async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[0] = WITH_PASSAGE;
		const { loader, calls } = fakeRuntime(pages, { failRender: [1] });
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		await vi.waitFor(() => expect(calls.render).toContain(1));
		await vi.waitFor(() =>
			expect(pageAt(container, 1).getAttribute('aria-label')).toBe('Page 1 of VA Benefits Guide')
		);

		box.scrollTop = box.scrollHeight;
		await vi.waitFor(() => expect(calls.render).toContain(12));
		box.scrollTop = 0;
		await vi.waitFor(() => expect(calls.render.filter((n) => n === 1)).toHaveLength(2));
		await vi.waitFor(() =>
			expect(pageAt(container, 1).getAttribute('aria-label')).toBe(
				'Page 1 of VA Benefits Guide, cited passage marked'
			)
		);
		expect(pageAt(container, 1).querySelectorAll('.pdf__mark').length).toBeGreaterThan(0);
	});

	// A page released while it draws was cancelled, not failed: like any page not yet drawn, it still claims the
	// mark it carries.
	it('still claims the mark on a page released while it was drawing', async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[0] = WITH_PASSAGE;
		const { loader, calls } = fakeRuntime(pages, { holdRender: new Promise<void>(() => {}) });
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		await vi.waitFor(() => expect(calls.render).toContain(1));

		box.scrollTop = box.scrollHeight;
		await vi.waitFor(() => expect(calls.cleanup).toContain(1));
		await frames(2);
		expect(pageAt(container, 1).getAttribute('aria-label')).toBe(
			'Page 1 of VA Benefits Guide, cited passage marked'
		);
	});

	// Zeroing a canvas frees its pixels, but the library keeps what it decoded for the page - its images above
	// all - until it is told the page may go.
	it('lets the library free a page it releases', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));
		await vi.waitFor(() => expect(calls.render).toContain(1));
		expect(calls.cleanup).not.toContain(1);

		box.scrollTop = box.scrollHeight;
		await vi.waitFor(() => expect(calls.cleanup).toContain(1));
	});

	// A canvas keeps its pixels until it is zeroed or collected, and a browser may count every canvas against
	// a cap, so leaving the document frees them at once.
	it('frees every canvas when it closes', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container, unmount } = render(PdfView, {
			props: props(loader, { page: 1 }),
			target: box
		});
		await vi.waitFor(() => expect(calls.render).toContain(2));
		const canvases = [...container.querySelectorAll('canvas')];
		expect(canvases.filter((canvas) => canvas.width > 0).length).toBeGreaterThan(0);

		unmount();
		expect(canvases.filter((canvas) => canvas.width !== 0 || canvas.height !== 0)).toEqual([]);
	});

	it('frees every canvas when it moves to another document', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container, rerender } = render(PdfView, {
			props: props(loader, { page: 1 }),
			target: box
		});
		await vi.waitFor(() => expect(calls.render).toContain(2));
		const canvases = [...container.querySelectorAll('canvas')];
		expect(canvases.filter((canvas) => canvas.width > 0).length).toBeGreaterThan(0);

		await rerender({ url: '/docs/other.pdf' });
		await vi.waitFor(() => expect(calls.getDocument).toHaveLength(2));
		expect(canvases.filter((canvas) => canvas.width !== 0 || canvas.height !== 0)).toEqual([]);
	});

	// A page is drawn to the width it has. A phone turned, or a window resized, draws the pages in view again at
	// the new width, rather than stretching the bitmaps drawn for the old one.
	it('draws the pages in view again when the view changes width', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		const canvas = () => pageAt(container, 1).querySelector('canvas') as HTMLCanvasElement;
		// How far the canvas is from the page's width in device pixels. Within a pixel is drawn to it: the width
		// passes through the library's scale on its way to the canvas.
		const offBy = () =>
			Math.abs(canvas().width - Math.floor(pageAt(container, 1).clientWidth * devicePixelRatio));
		await vi.waitFor(() => expect(calls.render).toContain(1));
		await vi.waitFor(() => expect(offBy()).toBeLessThanOrEqual(1));
		const wide = canvas().width;
		const drawsOfFirst = () => calls.render.filter((n) => n === 1).length;
		expect(drawsOfFirst()).toBe(1);

		box.style.width = '200px';
		await vi.waitFor(() => expect(drawsOfFirst()).toBe(2));
		await vi.waitFor(() => expect(offBy()).toBeLessThanOrEqual(1));
		expect(canvas().width).toBeLessThan(wide);
	});

	// Hidden - the reader showing its text - the pages have no width at all, and nothing to be drawn at.
	it('draws nothing when the pages are hidden', async () => {
		const box = scroller();
		const holder = document.createElement('div');
		box.append(holder);
		const { loader, calls } = fakeRuntime(TWELVE());
		render(PdfView, { props: props(loader, { page: 1 }), target: holder });
		await vi.waitFor(() => expect(calls.render).toContain(2));
		await frames(3);
		const draws = calls.render.length;

		holder.hidden = true;
		await frames(3);
		expect(calls.render).toHaveLength(draws);
	});

	it('draws a page again at the new width when the width changed while it was drawing', async () => {
		let finish!: () => void;
		const holdRender = new Promise<void>((resolve) => (finish = resolve));
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE(), { holdRender });
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		const canvas = () => pageAt(container, 1).querySelector('canvas') as HTMLCanvasElement;
		const offBy = () =>
			Math.abs(canvas().width - Math.floor(pageAt(container, 1).clientWidth * devicePixelRatio));
		await vi.waitFor(() => expect(calls.render).toContain(1));
		const wide = canvas().width;

		box.style.width = '200px';
		await frames(2);
		finish();
		await vi.waitFor(() => expect(calls.render.filter((n) => n === 1)).toHaveLength(2));
		await vi.waitFor(() => expect(offBy()).toBeLessThanOrEqual(1));
		expect(canvas().width).toBeLessThan(wide);
	});

	// Every page has its own size from the start, read from the document before any is shown, so nothing moves
	// when a page is drawn: a landscape page is shorter from the first.
	it('sizes every page to its own shape before it is drawn', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE(), { sizes: { 12: [800, 600] } });
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));

		const portrait = pageAt(container, 1).getBoundingClientRect();
		expect(calls.render).not.toContain(12);
		expect(pageAt(container, 12).getBoundingClientRect().height).toBeCloseTo(
			(portrait.width * 600) / 800,
			0
		);
	});

	// One page the library cannot hand back does not cost the reader the document. That page takes the first
	// page's shape, as every page did before each was sized from its own, and the rest stand as they are.
	it("gives a page whose size cannot be read the first page's shape, and still shows the document", async () => {
		const box = scroller();
		const onfail = vi.fn();
		const landscape: [number, number] = [800, 600];
		const { loader } = fakeRuntime(TWELVE(), { failGetPage: [7], sizes: { 1: landscape } });
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, onfail }),
			target: box
		});

		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));
		const first = pageAt(container, 1).getBoundingClientRect();
		expect(first.height).toBeCloseTo((first.width * 600) / 800, 0);
		expect(pageAt(container, 7).getBoundingClientRect().height).toBeCloseTo(first.height, 0);
		expect(pageAt(container, 6).getBoundingClientRect().height).toBeCloseTo(
			(first.width * 800) / 600,
			0
		);
		expect(onfail).not.toHaveBeenCalled();
	});

	// Landscape pages above the passage are drawn once the view lands. Sized from the start, they move nothing,
	// so the passage stays where it landed - with no scroll anchoring to put it back, as in WebKit.
	it('keeps the passage where it landed when the pages above it are drawn', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const pages = TWELVE();
		pages[8] = WITH_PASSAGE;
		const landscape: [number, number] = [800, 600];
		const { loader, calls } = fakeRuntime(pages, {
			sizes: { 6: landscape, 7: landscape, 8: landscape }
		});
		const { container } = render(PdfView, { props: props(loader, { page: 9 }), target: box });

		await vi.waitFor(() => expect(calls.render).toEqual(expect.arrayContaining([7, 8])));
		await frames(2);
		const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
		expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
	});

	// Edge case 5: a passage that starts on its page and runs onto the next is marked on both.
	it('marks the passage on each page it spans', async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[2] = [run('Lead in text.', 40, 740), run('The notice explains who may apply', 40, 60)];
		pages[3] = [run('and what evidence is required.', 40, 760), run('Trailing text.', 40, 740)];
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, { props: props(loader, { page: 3 }), target: box });
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));

		await vi.waitFor(() =>
			expect(pageAt(container, 3).querySelectorAll('.pdf__mark').length).toBeGreaterThan(0)
		);
		expect(pageAt(container, 4).querySelectorAll('.pdf__mark').length).toBeGreaterThan(0);
		expect(pageAt(container, 3).getAttribute('aria-label')).toContain('cited passage marked');
		expect(pageAt(container, 4).getAttribute('aria-label')).toContain('cited passage marked');
	});

	// A screen reader reads on from the page it lands on. The cited passage's text comes right after the page it
	// is marked on, not after every page to the end of the document.
	it("puts the cited passage's text right after the page it is marked on", async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[0] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });

		await vi.waitFor(() => expect(container.querySelector('.pdf__passage')).not.toBeNull());
		expect(pageAt(container, 1).nextElementSibling).toBe(container.querySelector('.pdf__passage'));
		expect(container.querySelectorAll('.pdf__passage')).toHaveLength(1);
	});

	it("puts the cited passage's text after the first of the pages it is marked on", async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[2] = [run('Lead in text.', 40, 740), run('The notice explains who may apply', 40, 60)];
		pages[3] = [run('and what evidence is required.', 40, 760), run('Trailing text.', 40, 740)];
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, { props: props(loader, { page: 3 }), target: box });

		await vi.waitFor(() => expect(container.querySelector('.pdf__passage')).not.toBeNull());
		expect(pageAt(container, 4).querySelectorAll('.pdf__mark').length).toBeGreaterThan(0);
		expect(pageAt(container, 3).nextElementSibling).toBe(container.querySelector('.pdf__passage'));
	});

	it("puts the cited passage's text after the page it lands on when it is marked on none", async () => {
		const box = scroller();
		const { loader } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 2 }), target: box });

		await vi.waitFor(() => expect(container.querySelector('.pdf__passage')).not.toBeNull());
		expect(pageAt(container, 2).nextElementSibling).toBe(container.querySelector('.pdf__passage'));
	});

	// An answer lands on the passage itself: its first line sits just below the top of the view.
	it("lands with the passage's first line near the top of the view", async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, { props: props(loader, { page: 5 }), target: box });

		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
		await vi.waitFor(() => {
			const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
			expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
		});
		// The passage is on page 5, so the line it lands on is on page 5.
		const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
		const sheet = pageAt(container, 5).getBoundingClientRect();
		expect(bar.top).toBeGreaterThanOrEqual(sheet.top);
		expect(bar.bottom).toBeLessThanOrEqual(sheet.bottom);
	});

	it('reports the page in view as the reader scrolls', async () => {
		const box = scroller();
		const onpage = vi.fn();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, onpage }),
			target: box
		});
		await vi.waitFor(() => expect(calls.render).toContain(1));
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));

		// A third of the way down a 600 px view is 200 px: page 4's top reaches that line here.
		box.scrollTop = topIn(pageAt(container, 4), box) - 200;
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(4));
	});

	// Measuring reads every page's box. However often a scroll is reported, that is done once a frame at most.
	it('measures the pages at most once a frame, however often a scroll is reported', async () => {
		const box = scroller();
		const onpage = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, onpage }),
			target: box
		});
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));
		await frames(2);
		const measured = vi.spyOn(pageAt(container, 5), 'getBoundingClientRect');

		for (let i = 0; i < 5; i++) box.dispatchEvent(new Event('scroll'));
		await frames(2);
		expect(measured).toHaveBeenCalledTimes(1);
	});

	// A measure still waiting for its frame when the document is replaced would read pages that are gone.
	it('measures nothing for a document it has moved on from', async () => {
		const box = scroller();
		const onpage = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { rerender } = render(PdfView, {
			props: props(loader, { page: 1, onpage }),
			target: box
		});
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));
		const reports = onpage.mock.calls.length;
		const errors: unknown[] = [];
		const record = (event: ErrorEvent) => errors.push(event.error);
		window.addEventListener('error', record);
		try {
			box.dispatchEvent(new Event('scroll'));
			await rerender({ url: '/docs/other.pdf', loader: () => new Promise<PdfRuntime>(() => {}) });
			await frames(3);
			expect(errors).toEqual([]);
			expect(onpage.mock.calls.length).toBe(reports);
		} finally {
			window.removeEventListener('error', record);
		}
	});

	// The reader hides the pages while its text is shown, and the text scrolls the same body. A hidden page has
	// no box, so every page measures at the top and the last one would be named as the page in view.
	it('names no page while the pages are hidden and the body scrolls', async () => {
		const box = scroller();
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		box.append(holder, text);
		const onpage = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		render(PdfView, { props: props(loader, { page: 1, onpage }), target: holder });
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));

		holder.hidden = true;
		box.scrollTop = 2000;
		await frames(3);
		expect(onpage).toHaveBeenLastCalledWith(1);
	});

	// A document that finishes loading while the reader shows its text has nothing to land on, and landing would
	// scroll the text instead. It says where the passage is at once, and lands when its pages are shown.
	it('lands when its pages are shown, leaving the text where it was while they are hidden', async () => {
		const box = scroller();
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		box.append(holder, text);
		holder.hidden = true;
		box.scrollTop = 2000;
		const onlocate = vi.fn();
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, {
			props: props(loader, { page: 5, onlocate }),
			target: holder
		});
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(3);
		expect(box.scrollTop).toBe(2000);

		holder.hidden = false;
		await vi.waitFor(() => {
			const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
			expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
		});
		expect(document.activeElement).toBe(pageAt(container, 5));
	});

	// A landing happens once. A phone turned or a window resized afterwards keeps the reader's place - the page at
	// the top of the view, and how far down it - though every page has a new height, and the pager names the page
	// then in view. The scroller keeps no place of its own here, as in WebKit, which has no scroll anchoring.
	it('lands once, and a width change afterwards keeps the place the reader scrolled to', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const onlocate = vi.fn();
		const onpage = vi.fn();
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, {
			props: props(loader, { page: 5, onlocate, onpage }),
			target: box
		});
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		box.scrollTop = topIn(pageAt(container, 8), box) + 0.3 * pageAt(container, 8).clientHeight;
		await frames(2);
		expect(placeOn(container, box, 8)).toBeCloseTo(0.3, 2);

		box.style.width = '150px';
		await frames(3);
		expect(placeOn(container, box, 8)).toBeCloseTo(0.3, 2);
		expect(onpage).toHaveBeenLastCalledWith(inView(container, box));
	});

	// What the reader places above the pages in the same body - its switch, its note, its Save and the Save's
	// lines - can change height, or be added, once the view has its place. With no scroll anchoring, as in WebKit,
	// the pages would move under the reader; they stay.
	describe('with lines above the pages that change', () => {
		const landed = async () => {
			const box = scroller();
			box.style.overflowAnchor = 'none';
			const lead = document.createElement('div');
			lead.style.height = '40px';
			const holder = document.createElement('div');
			box.append(lead, holder);
			const onlocate = vi.fn();
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			const { container, rerender } = render(PdfView, {
				props: props(loader, { page: 5, onlocate }),
				target: holder
			});
			await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
			await frames(2);
			return { box, lead, holder, container, rerender, at: placeOn(container, box, 5) };
		};
		const barFromTop = (container: Element, box: HTMLElement) =>
			(container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect().top -
			box.getBoundingClientRect().top;

		it('keeps its place when a line above the pages grows', async () => {
			const { box, lead, container, at } = await landed();
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);

			lead.style.height = '100px';
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
			expect(placeOn(container, box, 5)).toBeCloseTo(at, 2);
		});

		// A scroll's report can be waiting for its frame when a line above grows - the reader's Save showing its
		// button, just after the view went back to its place. The report then reads the moved pages before their
		// new size is reported. The reader has not scrolled, so that is no new place.
		it('keeps its place when a line above grows while a scroll report waits for its frame', async () => {
			const { box, lead, container, at } = await landed();
			// A task of its own, as a download ending is: a step run from a frame would hide the order.
			await new Promise((resolve) => setTimeout(resolve, 0));
			box.dispatchEvent(new Event('scroll'));
			lead.style.height = '100px';
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
			expect(placeOn(container, box, 5)).toBeCloseTo(at, 2);
		});

		// The view has gone back once, and its move is not yet reported, when the line grows again: that move is
		// the view's own, not the reader's, so the place stays.
		it('keeps its place when a line above grows again before the view going back is reported', async () => {
			const { box, lead, container, at } = await landed();
			await new Promise((resolve) => setTimeout(resolve, 0));
			lead.style.height = '100px';
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
			lead.style.height = '160px';
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
			expect(placeOn(container, box, 5)).toBeCloseTo(at, 2);
		});

		// A page asked for from the page bar is the reader's new place at once: a line above growing before the move
		// is reported leaves the view on that page.
		it('stays on a page asked for when a line above grows before the move is reported', async () => {
			const { box, lead, container, rerender } = await landed();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await rerender({ request: { page: 7 } });
			lead.style.height = '100px';
			await frames(3);
			expect(topIn(pageAt(container, 7), box) - box.scrollTop).toBeCloseTo(8, -1);
		});

		it('keeps its place when a line is added above the pages', async () => {
			const { box, holder, container, at } = await landed();
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);

			const line = document.createElement('div');
			line.style.height = '60px';
			holder.before(line);
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
			expect(placeOn(container, box, 5)).toBeCloseTo(at, 2);

			// Once added, it is watched as the rest are.
			line.style.height = '120px';
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
		});

		// Switching to the text hides the pages and drops the reader's note above them in the same moment. The
		// scroll is the text's then: hidden, the pages go back to no place.
		it('leaves the scroll to the text when a line above goes as the pages are hidden', async () => {
			const box = scroller();
			box.style.overflowAnchor = 'none';
			// Below the reader's title, as the reader's body is.
			box.style.marginTop = '50px';
			const note = document.createElement('div');
			note.style.height = '60px';
			const holder = document.createElement('div');
			const text = document.createElement('div');
			text.style.height = '5000px';
			text.hidden = true;
			box.append(note, holder, text);
			const onlocate = vi.fn();
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			render(PdfView, { props: props(loader, { page: 5, onlocate }), target: holder });
			await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
			await frames(2);

			await new Promise((resolve) => setTimeout(resolve));
			holder.hidden = true;
			text.hidden = false;
			note.remove();
			box.scrollTop = 700;
			await frames(3);
			expect(box.scrollTop).toBe(700);
		});

		// A document that loaded while the text was shown, shown with focus in the body - which its landing may
		// not take - stays at the scroll it is shown at, though a line is added above the pages in that moment.
		it('stays at the scroll it is shown at when a line is added above as it lands without focus', async () => {
			const box = scroller();
			box.style.overflowAnchor = 'none';
			const control = document.createElement('button');
			control.textContent = 'Save';
			const holder = document.createElement('div');
			holder.hidden = true;
			const text = document.createElement('div');
			text.style.height = '5000px';
			box.append(control, holder, text);
			const onlocate = vi.fn();
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			render(PdfView, {
				props: props(loader, { page: 5, mayFocus: () => false, onlocate }),
				target: holder
			});
			await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
			control.focus();
			box.scrollTop = 300;
			await frames(2);

			await new Promise((resolve) => setTimeout(resolve));
			const line = document.createElement('div');
			line.style.height = '60px';
			holder.before(line);
			holder.hidden = false;
			text.hidden = true;
			await frames(3);
			expect(document.activeElement).toBe(control);
			expect(box.scrollTop).toBe(300);
		});

		// Only what is above the pages in the scrolled body is watched. Something added elsewhere on the page in
		// the moment the reader scrolls does not send the view back over the reader's own scroll.
		it("keeps the reader's scroll when something outside the scrolled body is added as it scrolls", async () => {
			const { box, container } = await landed();
			const banner = document.createElement('div');
			banner.style.height = '30px';
			try {
				await new Promise((resolve) => setTimeout(resolve));
				box.scrollTop = topIn(pageAt(container, 8), box);
				box.before(banner);
				await frames(3);
				expect(placeOn(container, box, 8)).toBeCloseTo(0, 2);
			} finally {
				banner.remove();
			}
		});

		// The reader adds its note as it hears where the passage is - as the view lands, before the next frame.
		it('keeps the passage where it landed when a line is added above the pages as it lands', async () => {
			const box = scroller();
			box.style.overflowAnchor = 'none';
			const holder = document.createElement('div');
			box.append(holder);
			const onlocate = vi.fn(() => {
				const note = document.createElement('div');
				note.style.height = '60px';
				holder.before(note);
			});
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			// Landed in a task of its own, as a download's end is: inside a frame, the browser would report the
			// line's size before the landing's scroll is read, and put right what this is here to catch.
			await new Promise((resolve) => setTimeout(resolve));
			const { container } = render(PdfView, {
				props: props(loader, { page: 5, onlocate }),
				target: holder
			});
			await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
		});

		it('keeps the passage where it landed when a line is added above the pages just after it lands', async () => {
			const box = scroller();
			box.style.overflowAnchor = 'none';
			const holder = document.createElement('div');
			box.append(holder);
			const onlocate = vi.fn(() =>
				queueMicrotask(() => {
					const note = document.createElement('div');
					note.style.height = '60px';
					holder.before(note);
				})
			);
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			await new Promise((resolve) => setTimeout(resolve));
			const { container } = render(PdfView, {
				props: props(loader, { page: 5, onlocate }),
				target: holder
			});
			await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
			await frames(3);
			expect(barFromTop(container, box)).toBeCloseTo(24, -1);
		});
	});

	// Hidden while the reader shows its text, the pages keep their place. Shown again - at a new width, a phone
	// turned while the text was up - they go back to it, not to where the text left the scroll.
	it('goes back to its place when shown again, though the width changed while it was hidden', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		text.hidden = true;
		box.append(holder, text);
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: holder });
		await vi.waitFor(() => expect(calls.render).toContain(1));
		box.scrollTop = topIn(pageAt(container, 8), box) + 0.3 * pageAt(container, 8).clientHeight;
		await frames(2);

		holder.hidden = true;
		text.hidden = false;
		box.scrollTop = 1000;
		await frames(2);
		box.style.width = '150px';
		await frames(2);
		holder.hidden = false;
		text.hidden = true;
		await frames(3);
		expect(placeOn(container, box, 8)).toBeCloseTo(0.3, 2);
	});

	// A scroll of the text still to be reported as the pages are shown - a smooth or momentum scroll running as
	// the view switches - is reported before the pages are back at their place. It is the text's, not theirs.
	it('goes back to its place when shown in the same moment as the text scrolls', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		text.hidden = true;
		box.append(holder, text);
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: holder });
		await vi.waitFor(() => expect(calls.render).toContain(1));
		box.scrollTop = topIn(pageAt(container, 8), box) + 0.3 * pageAt(container, 8).clientHeight;
		await frames(2);

		holder.hidden = true;
		text.hidden = false;
		await frames(2);
		box.style.width = '150px';
		await frames(2);
		// In a task of its own, as a tap is: inside a frame, the browser would lay the pages out and report their
		// new size before that frame ended, ahead of the scroll.
		await new Promise((resolve) => setTimeout(resolve));
		box.scrollTop = 1000;
		holder.hidden = false;
		text.hidden = true;
		await frames(3);
		expect(placeOn(container, box, 8)).toBeCloseTo(0.3, 2);
	});

	// Back at their place, the pages follow the reader's scroll again, with no landing to start them.
	it('reports the page in view again as the reader scrolls once the pages are shown again', async () => {
		const box = scroller();
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		text.hidden = true;
		box.append(holder, text);
		const onpage = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, onpage }),
			target: holder
		});
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));

		holder.hidden = true;
		text.hidden = false;
		await frames(2);
		holder.hidden = false;
		text.hidden = true;
		await frames(2);
		box.scrollTop = topIn(pageAt(container, 4), box) - 200;
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(4));
	});

	// A document that replaces one at its place starts at none. Loaded while its pages are hidden, and shown as
	// the text scrolls in the moment it is ready - before the browser has reported the hidden pages' size - it
	// names no page from the text's scroll before it lands.
	it('names only the page it lands on when a new document is shown as the text scrolls', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		text.hidden = true;
		box.append(holder, text);
		const onpage = vi.fn();
		let showWhenReady = false;
		const onlocate = vi.fn(() => {
			if (!showWhenReady) return;
			// After the view's own work for this update, and before the next frame.
			queueMicrotask(() => {
				onpage.mockClear();
				box.scrollTop = 1000;
				holder.hidden = false;
				text.hidden = true;
			});
		});
		const first = fakeRuntime(TWELVE());
		const { rerender } = render(PdfView, {
			props: props(first.loader, { page: 1, onpage, onlocate }),
			target: holder
		});
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));

		let release!: () => void;
		const holdDocument = new Promise<void>((resolve) => (release = resolve));
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const next = fakeRuntime(pages, { holdDocument });
		await rerender({ url: '/docs/other.pdf', page: 5, loader: next.loader });
		await vi.waitFor(() => expect(next.calls.tasks).toHaveLength(1));
		holder.hidden = true;
		text.hidden = false;
		await frames(2);
		// In a task of its own, as a download's end is, not inside a frame.
		await new Promise((resolve) => setTimeout(resolve));
		showWhenReady = true;
		release();
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(2));
		await frames(3);
		expect(holder.hidden).toBe(false);
		expect(onpage.mock.calls).toEqual([[5]]);
	});

	// The reader may refuse the landing its focus: the user moved focus while the document loaded. The view
	// still goes to the passage, and focus stays where the user put it.
	it('lands on the passage without taking focus when it may not', async () => {
		const box = scroller();
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		try {
			elsewhere.focus();
			const pages = TWELVE();
			pages[4] = WITH_PASSAGE;
			const { loader } = fakeRuntime(pages);
			const { container } = render(PdfView, {
				props: props(loader, { page: 5, mayFocus: () => false }),
				target: box
			});

			await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
			await vi.waitFor(() => {
				const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
				expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
			});
			await frames(2);
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});

	// With focus on something in the scrolled body itself - a control the reader places above the pages - moving
	// the view would carry that control away from the user. The view stays, and still names the page in view.
	it('stays where it is when it may not take focus and focus is in the scrolled body', async () => {
		const box = scroller();
		const control = document.createElement('button');
		control.textContent = 'Save';
		const holder = document.createElement('div');
		box.append(control, holder);
		control.focus();
		const onlocate = vi.fn();
		const onpage = vi.fn();
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		render(PdfView, {
			props: props(loader, { page: 5, mayFocus: () => false, onlocate, onpage }),
			target: holder
		});

		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(3);
		expect(box.scrollTop).toBe(0);
		expect(document.activeElement).toBe(control);
		expect(onpage).toHaveBeenLastCalledWith(1);
	});

	it('names the page in view when its pages are shown, though it stays where focus is', async () => {
		const box = scroller();
		const control = document.createElement('button');
		control.textContent = 'Save';
		const holder = document.createElement('div');
		holder.hidden = true;
		box.append(control, holder);
		control.focus();
		const onlocate = vi.fn();
		const onpage = vi.fn();
		const pages = TWELVE();
		pages[4] = WITH_PASSAGE;
		const { loader } = fakeRuntime(pages);
		render(PdfView, {
			props: props(loader, { page: 5, mayFocus: () => false, onlocate, onpage }),
			target: holder
		});
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(3);
		expect(onpage).not.toHaveBeenCalled();

		holder.hidden = false;
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));
		expect(box.scrollTop).toBe(0);
		expect(document.activeElement).toBe(control);
	});

	// Shown for the first time with the scroll already where the landing puts it, the view still names its page:
	// the pager waits for it, and no scroll comes to prompt it.
	it('names the page in view after landing, even when the landing did not move the scroll', async () => {
		const box = scroller();
		const holder = document.createElement('div');
		holder.hidden = true;
		box.append(holder);
		const onpage = vi.fn();
		const onlocate = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		render(PdfView, {
			props: props(loader, { page: 1, anchor: '', onpage, onlocate }),
			target: holder
		});
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(3);
		expect(onpage).not.toHaveBeenCalled();

		holder.hidden = false;
		await vi.waitFor(() => expect(onpage).toHaveBeenLastCalledWith(1));
	});

	it('moves to a page asked for, and again when asked for the same page twice', async () => {
		const box = scroller();
		const { loader, calls } = fakeRuntime(TWELVE());
		const { container, rerender } = render(PdfView, {
			props: props(loader, { page: 1 }),
			target: box
		});
		await vi.waitFor(() => expect(container.querySelectorAll('.pdf__page')).toHaveLength(12));
		await vi.waitFor(() => expect(calls.render).toContain(1));

		await rerender({ request: { page: 7 } });
		await vi.waitFor(() =>
			expect(box.scrollTop).toBeCloseTo(topIn(pageAt(container, 7), box) - 8, -1)
		);
		box.scrollTop = 0;
		await rerender({ request: { page: 7 } });
		await vi.waitFor(() =>
			expect(box.scrollTop).toBeCloseTo(topIn(pageAt(container, 7), box) - 8, -1)
		);
	});

	// Page 1 with no passage is the start of the document: the view goes to the very top, so what sits above
	// the first page stays in sight instead of scrolling away with the first page's own top.
	it('lands at the very top when page 1 carries no passage', async () => {
		const box = scroller();
		const onlocate = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, anchor: '', onlocate }),
			target: box
		});
		box.prepend(above());
		// The landing scrolls just before it reports, so a report means the landing has happened.
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(topIn(pageAt(container, 1), box)).toBeGreaterThan(8);
		expect(box.scrollTop).toBe(0);
	});

	// At the very top, the view shows what sits above the first page. A phone turned keeps it there: the pages
	// change height below that line, and the top of the document is still the top.
	it('stays at the very top of the document through a width change', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const onlocate = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { container } = render(PdfView, {
			props: props(loader, { page: 1, anchor: '', onlocate }),
			target: box
		});
		box.prepend(above());
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(2);
		expect(box.scrollTop).toBe(0);

		box.style.width = '150px';
		await frames(3);
		expect(topIn(pageAt(container, 1), box)).toBeGreaterThan(8);
		expect(box.scrollTop).toBe(0);
	});

	it('goes back to the very top when shown again after the text was scrolled', async () => {
		const box = scroller();
		box.style.overflowAnchor = 'none';
		const holder = document.createElement('div');
		const text = document.createElement('div');
		text.style.height = '5000px';
		text.hidden = true;
		box.append(holder, text);
		const onlocate = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		render(PdfView, {
			props: props(loader, { page: 1, anchor: '', onlocate }),
			target: holder
		});
		box.prepend(above());
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		await frames(2);

		holder.hidden = true;
		text.hidden = false;
		box.scrollTop = 1000;
		await frames(2);
		holder.hidden = false;
		text.hidden = true;
		await frames(3);
		expect(box.scrollTop).toBe(0);
	});

	it('moves to the very top when page 1 is asked for and carries no passage', async () => {
		const box = scroller();
		const onlocate = vi.fn();
		const { loader } = fakeRuntime(TWELVE());
		const { container, rerender } = render(PdfView, {
			props: props(loader, { page: 5, onlocate }),
			target: box
		});
		box.prepend(above());
		await vi.waitFor(() => expect(onlocate).toHaveBeenCalledTimes(1));
		expect(box.scrollTop).toBeGreaterThan(0);

		await rerender({ request: { page: 1 } });
		await vi.waitFor(() => expect(box.scrollTop).toBe(0));
		expect(topIn(pageAt(container, 1), box)).toBeGreaterThan(8);
	});

	it('lands on a passage on page 1 itself, not at the very top', async () => {
		const box = scroller();
		const pages = TWELVE();
		pages[0] = [
			run('Lead in text.', 40, 740),
			run('The notice explains who may apply', 40, 400),
			run('and what evidence is required.', 40, 385)
		];
		const { loader } = fakeRuntime(pages);
		const { container } = render(PdfView, { props: props(loader, { page: 1 }), target: box });
		box.prepend(above());

		await vi.waitFor(() => expect(container.querySelector('.pdf__bar')).not.toBeNull());
		await vi.waitFor(() => {
			const bar = (container.querySelector('.pdf__bar') as HTMLElement).getBoundingClientRect();
			expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
		});
		expect(box.scrollTop).toBeGreaterThan(0);
	});

	// The page it is given can change without the document changing: it moves there, and reports what is
	// marked on that page, rather than loading the document again.
	it('moves to the page it is given and reports it, without loading the document again', async () => {
		const box = scroller();
		const onlocate = vi.fn();
		const pages = TWELVE();
		pages[5] = WITH_PASSAGE;
		const { loader, calls } = fakeRuntime(pages);
		const { container, rerender } = render(PdfView, {
			props: props(loader, { page: 5, onlocate }),
			target: box
		});
		await vi.waitFor(() =>
			expect(onlocate).toHaveBeenLastCalledWith({ marked: false, foundOn: [6], pageCount: 12 })
		);

		await rerender({ page: 6 });
		await vi.waitFor(() =>
			expect(onlocate).toHaveBeenLastCalledWith({ marked: true, foundOn: [6], pageCount: 12 })
		);
		expect(calls.getDocument).toHaveLength(1);
		const bar = (
			pageAt(container, 6).querySelector('.pdf__bar') as HTMLElement
		).getBoundingClientRect();
		expect(bar.top - box.getBoundingClientRect().top).toBeCloseTo(24, -1);
	});
});
