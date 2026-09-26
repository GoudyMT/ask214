<script lang="ts">
	import { untrack } from 'svelte';
	import { findAnchorInDocument, searchPages } from '$lib/sources/highlight-match';
	import {
		joinTextItems,
		rangeToBoxes,
		type Box,
		type PdfContentItem
	} from '$lib/sources/pdf-text';
	import {
		loadPdfRuntime,
		type PdfDocument,
		type PdfLoadingTask,
		type PdfPage,
		type PdfRenderTask,
		type PdfRuntime
	} from '$lib/sources/pdf-runtime';
	import { pageInView, scrollParent } from '$lib/sources/scroll-pages';

	// The whole served document as a scrolled stack of pages, the cited passage marked on every page it covers.
	// Pages are drawn as they come near the view and released when far from it, each holding its shape until
	// then, so the scroll never jumps and a 217-page guide never holds 217 drawn pages. On a load failure it
	// reports up rather than drawing anything partial, because the reader around it falls back to its text
	// view - an empty canvas or a spinner that never ends would be worse than the view the user already had.
	let {
		url,
		page,
		anchor,
		quote,
		title,
		bytes,
		onfail,
		onlocate,
		onpage,
		mayFocus = () => true,
		request = null,
		stallAfter = 30_000,
		loader = loadPdfRuntime
	}: {
		url: string;
		// The page to land on, 1-based, as the citation carries it. Changing it moves there without loading
		// the document again.
		page: number;
		anchor: string;
		// The words the answer showed. When they are found inside the passage, they carry the tint and the
		// passage keeps only a bar, so the eye lands on what the user just read.
		quote?: string;
		title: string;
		// The document's size in bytes: stated while the page loads, and the full length of the loading bar.
		bytes?: number;
		onfail?: () => void;
		// For the page landed on: whether the passage is marked there, every page it was found on (empty when
		// found nowhere), and the page count - so the reader can say so when that page carries no mark.
		onlocate?: (result: { marked: boolean; foundOn: number[]; pageCount: number }) => void;
		// The page in view, each time it changes as the reader scrolls.
		onpage?: (page: number) => void;
		// Asked as the view lands whether the landing page may take focus. The reader's rule: the user may have
		// moved focus while the document loaded.
		mayFocus?: () => boolean;
		// A page asked for by number. Each request is a new object, so asking twice still moves.
		request?: { page: number } | null;
		// How long, in ms, the download may go with nothing arriving before it is given up as failed. Long
		// enough for the library's worker, which loads before any of the document arrives on a first open.
		stallAfter?: number;
		// The runtime is injected so the view can be exercised without the real library; the default is the
		// lazy loader, which keeps the library out of every bundle until a document is opened.
		loader?: () => Promise<PdfRuntime>;
	} = $props();

	// A page's shape and its marks as fractions of the page, so the stack follows the width of the view: a
	// scrollbar appearing, or a phone turning, reflows it instead of pushing pages out sideways.
	type Sheet = { ratio: number; marks: Box[]; bar: { top: number; height: number } | null };

	// Where a landing puts the passage's first line, and a page asked for by number, below the view's top.
	const LAND_GAP = 24;
	const PAGE_GAP = 8;

	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	// Bytes of the document received so far. The page waits for the whole file, so this is what shows it moving.
	let arrived = $state(0);
	let sheets = $state<Sheet[]>([]);
	let drawn = $state<boolean[]>([]);
	// Pages whose last draw failed. Such a page keeps its placeholder and claims no mark over it.
	let broken = $state<boolean[]>([]);
	let quoted = $state(false);
	// Plain, not state: read only when the landing reports where the passage was found, never by the markup.
	let foundOn: number[] = [];
	let wrapperEl = $state<HTMLElement>();
	let pageEls = $state<HTMLElement[]>([]);
	let canvasEls = $state<HTMLCanvasElement[]>([]);
	// The loaded document the drawing reads. Plain, not state: it changes only when the document does.
	let doc: PdfDocument | null = null;
	// The page still to be landed on. A landing asked for while the pages are hidden - the reader showing its
	// text in the same body - waits until they are shown: they have no box to land on, and scrolling would move
	// the text.
	let pending = 0;
	// Where the reader is: the page at the top of the view, and how far down it the top is as a share of its
	// height. A share, not pixels: a phone turned gives every page a new height, and the same share of the same
	// page is the same place. WebKit keeps no place for a scroll whose content changes size, so this does. Page 0
	// is what sits above the first page.
	let place = { page: 1, at: 0 };
	// Whether the view is at that place. Not from the moment the pages are hidden until a landing or going back
	// puts them there again: a scroll reported in between - the text's, still running as the pages are shown -
	// is not the reader's place in the pages, and kept as one it would be where going back goes.
	let placed = false;
	// The scroll the place was last taken at, or put back to. A report of the same scroll is no move of the
	// reader's, though the pages may have moved under it - a line above them growing, read before its new size
	// is reported - so the place stays, and going back puts the view right.
	let seen = -1;
	// Names the page in view on the next frame; the tracking below sets it once the pages are ready.
	let measure = () => {};

	// Props are compared by value before any effect runs again: an update that hands over the same document,
	// page or request - a parent re-rendering, or a props object replaced whole - must not load, land or move
	// again. Only a real change does.
	const source = $derived(`${url}\n${anchor}\n${quote ?? ''}`);
	const landing = $derived(page);
	const asked = $derived(request);
	const runtime = $derived(loader);
	// The page the cited passage's text follows, so a screen reader reaches it from that page rather than after
	// every page to the end: the first page it is marked on, or the page landed on when it is marked on none.
	const passageAfter = $derived(sheets.findIndex((sheet) => sheet.marks.length > 0) + 1 || landing);

	$effect(() => {
		void source;
		const load = runtime;
		const target = untrack(() => ({ url, anchor, quote }));
		// The page the passage is searched from. Moving to another page later does not load again.
		const cited = untrack(() => landing);

		// Every await below can outlive this effect - the reader may close, or move to another citation, while
		// the document is still loading. `cancelled` stops a stale run from writing state it no longer owns.
		let cancelled = false;
		let task: PdfLoadingTask | null = null;
		let stall: ReturnType<typeof setTimeout> | undefined;
		status = 'loading';
		arrived = 0;
		sheets = [];
		drawn = [];
		broken = [];
		quoted = false;
		foundOn = [];
		doc = null;
		place = { page: 1, at: 0 };
		placed = false;

		(async () => {
			try {
				const library = await load();
				if (cancelled) return;
				// Whole, never in byte ranges. A document the user saved is one complete file, and the service
				// worker serves it to any later request for the url, so a range read would be handed the whole
				// file and misread it. The host ignores ranges anyway, answering with the whole file.
				const opened = library.getDocument({
					url: target.url,
					disableRange: true,
					disableStream: true
				});
				task = opened;
				// A connection that is up but silent would hold the loading box forever. Nothing arriving for
				// `stallAfter` is a failed load, and the download is stopped.
				const loaded = await new Promise<PdfDocument>((resolve, reject) => {
					const wait = () => {
						clearTimeout(stall);
						stall = setTimeout(() => {
							void opened.destroy();
							reject(new Error('E_PDF_STALLED'));
						}, stallAfter);
					};
					opened.onProgress = (progress: { loaded: number }) => {
						if (!cancelled) {
							arrived = progress.loaded;
							wait();
						}
					};
					wait();
					opened.promise.then(resolve, reject);
				}).finally(() => clearTimeout(stall));
				if (cancelled) return;

				// Every page takes its own shape before any is shown, so the stack has its full height at once and
				// nothing moves when a page is drawn: a landscape page among portrait ones would otherwise shrink
				// as it drew, and move the passage out of view. Reading every page's size is quick - 17 ms for
				// the 228 pages of the largest guide, measured with the library. A page whose size cannot be read
				// takes the first page's shape, as every page did before, rather than costing the reader the
				// whole document; it fails again when drawn, and keeps its placeholder.
				const shapeOf = async (n: number) => (await loaded.getPage(n)).getViewport({ scale: 1 });
				const first = await shapeOf(1);
				const shapes = await Promise.all(
					Array.from({ length: loaded.numPages }, (_, i) => shapeOf(i + 1).catch(() => first))
				);
				const next: Sheet[] = shapes.map((shape) => ({
					ratio: shape.height / shape.width,
					marks: [],
					bar: null
				}));

				// The search needs text for its whole window, not just the cited page, because a passage routinely
				// starts on its cited page and finishes on the next. Only those pages are read.
				const texts: string[] = new Array<string>(loaded.numPages).fill('');
				const read: { n: number; proxy: PdfPage; items: PdfContentItem[] }[] = [];
				for (const n of searchPages(cited, loaded.numPages)) {
					// The library hands back the page it already has for page 1.
					const proxy = await loaded.getPage(n);
					const { items } = await proxy.getTextContent();
					texts[n - 1] = joinTextItems(items);
					read.push({ n, proxy, items });
				}
				if (cancelled) return;

				const passage = findAnchorInDocument(texts, cited, target.anchor)?.ranges ?? [];
				// The quote counts only where it overlaps the passage: found anywhere else, it would point the eye
				// at text the answer did not come from, so the passage keeps the tint instead.
				const inside =
					target.quote && passage.length > 0
						? (findAnchorInDocument(texts, cited, target.quote)?.ranges ?? []).filter((range) =>
								passage.some(
									(p) => p.page === range.page && range.start < p.end && p.start < range.end
								)
							)
						: [];
				const tint = inside.length > 0 ? inside : passage;
				for (const { n, proxy, items } of read) {
					const sheet = next[n - 1];
					const onPage = passage.filter((range) => range.page === n);
					if (!sheet || onPage.length === 0) continue;
					const viewport = proxy.getViewport({ scale: 1 });
					const fraction = (b: Box): Box => ({
						x: b.x / viewport.width,
						y: b.y / viewport.height,
						width: b.width / viewport.width,
						height: b.height / viewport.height
					});
					sheet.marks = tint
						.filter((range) => range.page === n)
						.flatMap((range) => rangeToBoxes(items, range, viewport.transform))
						.map(fraction);
					const lines = onPage
						.flatMap((range) => rangeToBoxes(items, range, viewport.transform))
						.map(fraction);
					if (lines.length > 0) {
						const top = Math.min(...lines.map((b) => b.y));
						sheet.bar = { top, height: Math.max(...lines.map((b) => b.y + b.height)) - top };
					}
				}

				doc = loaded;
				quoted = inside.length > 0;
				foundOn = [...new Set(passage.map((range) => range.page))].sort((a, b) => a - b);
				sheets = next;
				drawn = next.map(() => false);
				status = 'ready';
			} catch {
				if (cancelled) return;
				status = 'failed';
				onfail?.();
			}
		})();

		return () => {
			cancelled = true;
			clearTimeout(stall);
			void task?.destroy();
		};
	});

	// Pages are drawn as they come within a view and a half of the scroll, and released beyond it.
	$effect(() => {
		if (status !== 'ready' || doc === null || !wrapperEl) return;
		const current = doc;
		const boxes = untrack(() => pageEls);
		// Held from the start, not read from the bindings as the effect ends: a document being replaced has had
		// its pages, and their canvases, taken out of the page by then.
		const canvases = untrack(() => [...canvasEls]);
		// By page: whether it is still wanted on screen, its draw while one runs (null until it starts
		// rendering), so a page released while drawing stays released, and the page as the library holds it.
		const wanted: boolean[] = [];
		const busy: (PdfRenderTask | null | undefined)[] = [];
		const proxies: PdfPage[] = [];
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const n = Number((entry.target as HTMLElement).dataset.page);
					wanted[n] = entry.isIntersecting;
					if (entry.isIntersecting) void draw(n);
					else release(n);
				}
			},
			{ root: scrollParent(wrapperEl), rootMargin: '150% 0px' }
		);
		for (const box of boxes) if (box) observer.observe(box);

		// The width the pages are drawn at. A phone turned or a window resized draws the pages in view again at
		// the new width, rather than stretching the bitmaps drawn for the old one. Hidden, the pages have no
		// width, and nothing is drawn at it. Shown again, or at a new width, the view goes back to its place:
		// the scroll was the text's, or its pixels now fall on another page.
		const wrapper = wrapperEl;
		let width = wrapper.clientWidth;
		const resized = new ResizeObserver(() => {
			if (!wrapper.clientWidth) {
				placed = false;
				return;
			}
			if (pending) land();
			else goBack();
			if (wrapper.clientWidth === width) return;
			width = wrapper.clientWidth;
			wanted.forEach((want, n) => {
				if (want) {
					drawn[n - 1] = false;
					void draw(n);
				}
			});
		});
		resized.observe(wrapper);

		async function draw(n: number): Promise<void> {
			const canvas = canvases[n - 1];
			const box = boxes[n - 1];
			if (busy[n] !== undefined || untrack(() => drawn[n - 1]) || !canvas || !box) return;
			busy[n] = null;
			const at = width;
			try {
				const proxy = await current.getPage(n);
				proxies[n] = proxy;
				if (!wanted[n]) return;
				// The canvas is drawn at the device pixel ratio so text stays sharp on a dense screen, while its
				// CSS size - and every mark - follows the page's box.
				const natural = proxy.getViewport({ scale: 1 });
				const viewport = proxy.getViewport({
					scale: (box.clientWidth || natural.width) / natural.width
				});
				const ratio = window.devicePixelRatio || 1;
				canvas.width = Math.floor(viewport.width * ratio);
				canvas.height = Math.floor(viewport.height * ratio);
				// At a ratio of 1 this is the identity transform, which the library applies as a no-op.
				const rendering = proxy.render({
					canvas,
					viewport,
					transform: [ratio, 0, 0, ratio, 0, 0]
				});
				busy[n] = rendering;
				await rendering.promise;
				if (wanted[n]) {
					drawn[n - 1] = true;
					broken[n - 1] = false;
				}
			} catch {
				// A page that fails or is released mid-draw keeps its placeholder; the rest of the document stands.
				// Only a failure is remembered: a released page was cancelled, and is no longer wanted.
				if (wanted[n]) broken[n - 1] = true;
			} finally {
				busy[n] = undefined;
				// The width changed while this page was drawing, so it was drawn at the old one: draw it again.
				if (at !== width && wanted[n]) {
					drawn[n - 1] = false;
					void draw(n);
				}
			}
		}

		function release(n: number): void {
			busy[n]?.cancel();
			// The library keeps what it decoded for a page - its images above all - until told the page may go.
			// Told while a draw is being cancelled, it lets go once that draw has stopped.
			proxies[n]?.cleanup();
			clear(canvases[n - 1]);
			drawn[n - 1] = false;
		}

		return () => {
			wanted.length = 0;
			observer.disconnect();
			resized.disconnect();
			for (const rendering of busy) rendering?.cancel();
			// A canvas keeps its pixels until it is collected, and a browser may count them against a cap.
			for (const canvas of canvases) clear(canvas);
		};
	});

	// Land on the page it is given, focused when the reader allows it, as the text view lands on its cited
	// passage - with the passage's first line just below the top when it is marked there - and say what is
	// marked on it. Instant, per the app's low-motion default.
	$effect(() => {
		if (status !== 'ready') return;
		const n = landing;
		untrack(() => {
			pending = n;
			land();
			onlocate?.({
				marked: (sheets[n - 1]?.marks.length ?? 0) > 0,
				foundOn,
				pageCount: sheets.length
			});
		});
	});

	// A page asked for by number lands at its top.
	$effect(() => {
		if (status !== 'ready' || asked === null) return;
		const n = asked.page;
		untrack(() => show(n, false));
	});

	// What sits above the pages in the scrolled body - the reader's switch, its note, its Save and the Save's
	// lines - can change height, or be added, once the view has its place. WebKit keeps no place for that, and the
	// pages would move under the reader, so the view goes back to its place each time. Watched are the elements
	// laid out before the pages in the body: the earlier siblings of the pages' box and of each box around it, and
	// any added among them. A new size is reported only after the next scroll is read, which would take the moved
	// pages as the place, so an element added sends the view back at once - as does this starting, for a line
	// added as the view landed. It is set up before the tracking below, which reads the place as it starts.
	$effect(() => {
		if (status !== 'ready' || !wrapperEl) return;
		const wrapper = wrapperEl;
		const root = scrollParent(wrapper);
		const keep = () => {
			if (placed && wrapper.offsetParent) goBack();
		};
		const above = new ResizeObserver(keep);
		const added = new MutationObserver(() => {
			watch();
			keep();
		});
		function watch(): void {
			above.disconnect();
			added.disconnect();
			for (let el: Element = wrapper; el !== root && el.parentElement; el = el.parentElement) {
				added.observe(el.parentElement, { childList: true });
				for (
					let before = el.previousElementSibling;
					before;
					before = before.previousElementSibling
				) {
					above.observe(before);
				}
			}
		}
		watch();
		untrack(keep);
		return () => {
			above.disconnect();
			added.disconnect();
		};
	});

	// Report the page in view each time it changes as the reader scrolls, and keep the reader's place. Measuring
	// reads every page's box, so it is done once a frame at most, however often the scroll is reported.
	$effect(() => {
		if (status !== 'ready') return;
		// Ready comes long after mount, and the wrapper is always drawn, so it is bound by then.
		const root = scrollParent(wrapperEl as HTMLElement);
		const source: HTMLElement | Window = root ?? window;
		let last = 0;
		const track = () => {
			// Hidden, as while the reader shows its text in the same body, the pages have no box: each measures at
			// the top, and the last page would be named. The page in view is the one it was, and so is the place,
			// until the pages are back at it.
			if (!placed || !wrapperEl?.offsetParent) return;
			const tops = pageEls.map((el) => topOf(el, root));
			const y = root ? root.scrollTop : window.scrollY;
			if (y !== seen) {
				place = placeAt(tops, y);
				seen = y;
			}
			const n = pageInView(tops, y, root ? root.clientHeight : window.innerHeight);
			if (n !== last) {
				last = n;
				onpage?.(n);
			}
		};
		let frame = 0;
		const later = () => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					track();
				});
		};
		source.addEventListener('scroll', later, { passive: true });
		measure = later;
		untrack(track);
		return () => {
			source.removeEventListener('scroll', later);
			cancelAnimationFrame(frame);
			measure = () => {};
		};
	});

	function land(): void {
		if (!pending || !wrapperEl?.offsetParent) return;
		const n = pending;
		const root = scrollParent(wrapperEl);
		pending = 0;
		if (mayFocus()) pageEls[n - 1]?.focus({ preventScroll: true });
		else if (root?.contains(document.activeElement)) {
			// Refused focus, the view still goes to the passage - unless focus is in the scrolled body itself, on a
			// control the reader places above the pages, which the scroll would carry away from the user. Then the
			// view stays where the user is, and that is its place.
			settle(root);
			return;
		}
		show(n, true);
	}

	/** Give a canvas's pixels back: a canvas of no size holds none. */
	function clear(canvas: HTMLCanvasElement | undefined): void {
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}

	/** An element's top in the scrolled content's own coordinates, as scrollTop counts it. */
	function topOf(el: HTMLElement, root: HTMLElement | null): number {
		return root
			? el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
			: el.getBoundingClientRect().top + window.scrollY;
	}

	/**
	 * Scroll a page into view: to the passage's first line when asked and it is marked there, else its top.
	 * Page 1 with no passage is the start of the document, so it goes to the very top, keeping in sight what
	 * sits above the first page.
	 */
	function show(n: number, onPassage: boolean): void {
		const el = pageEls[n - 1];
		if (!el) return;
		// Called only once ready, when the wrapper is bound, as above.
		const root = scrollParent(wrapperEl as HTMLElement);
		const bar = onPassage ? sheets[n - 1]?.bar : null;
		// No clamp at 0: the browser already clamps a scroll position to the content it scrolls.
		const y =
			n > 1 || bar ? topOf(el, root) + (bar ? bar.top * el.clientHeight - LAND_GAP : -PAGE_GAP) : 0;
		if (root) root.scrollTop = y;
		else window.scrollTo(0, y);
		settle(root);
	}

	/**
	 * The view is at the reader's place. Keep where that is at once, not when the scroll is next reported: a line
	 * added above the pages in the same moment - the reader's note on where the passage is - sends the view back
	 * to it. And name the page in view on the next frame, even when the scroll did not move and no scroll comes to
	 * prompt it.
	 */
	function settle(root: HTMLElement | null): void {
		seen = root ? root.scrollTop : window.scrollY;
		place = placeAt(
			pageEls.map((el) => topOf(el, root)),
			seen
		);
		placed = true;
		measure();
	}

	/**
	 * Put the view back at the reader's place, the pages laid out as they are now. It runs from the size
	 * observer, which the browser calls after that frame's scrolls are reported: a scroll the new layout itself
	 * causes is reported only after this, but one already under way as the pages are shown - the text's, as the
	 * view switches - is reported before it. So the place is not read from a scroll until this has put the
	 * pages back at it.
	 */
	function goBack(): void {
		const el = pageEls[Math.max(place.page, 1) - 1];
		if (!el) return;
		const root = scrollParent(wrapperEl as HTMLElement);
		const top = topOf(el, root);
		const y = place.page ? top + place.at * el.clientHeight : place.at * top;
		if (root) root.scrollTop = y;
		else window.scrollTo(0, y);
		seen = root ? root.scrollTop : window.scrollY;
		placed = true;
	}

	/**
	 * The place a scroll of `y` is at: the page at the top of the view, and how far down it the top is. Above the
	 * first page the view is in what sits over the pages, whose height is not a page's: that is page 0, and the
	 * share is of the height above page 1, so the very top stays the very top however the pages change.
	 */
	function placeAt(tops: readonly number[], y: number): { page: number; at: number } {
		const start = tops[0] ?? 0;
		if (y < start) return { page: 0, at: y / start };
		const n = pageInView(tops, y, 0);
		return { page: n, at: (y - (tops[n - 1] ?? 0)) / (pageEls[n - 1]?.clientHeight || 1) };
	}
</script>

<div class="pdf" bind:this={wrapperEl}>
	{#if status === 'loading'}
		<!-- A box in the page's shape, so the modal does not jump from one line to a full page. -->
		<div class="pdf__ph" role="status">
			<span
				>Loading page {page} of the document{bytes !== undefined
					? ` (${(bytes / 1e6).toFixed(1)} MB)`
					: ''}...</span
			>
			<!-- The line above already says it is loading and how large the file is; the bar only shows it moving. -->
			{#if bytes !== undefined}
				<progress class="pdf__load" max={bytes} value={arrived} aria-hidden="true"></progress>
			{/if}
		</div>
	{/if}
	<!-- The image role sits on each page's box, not its canvas: a canvas cannot carry it, and naming each page
	     once here means the canvas and the marks inside are presentational, so a page is announced once. -->
	{#each sheets as sheet, i (i)}
		<div
			class="pdf__page"
			role="img"
			tabindex="-1"
			data-page={i + 1}
			bind:this={pageEls[i]}
			aria-label="Page {i + 1} of {title}{sheet.marks.length > 0 && !broken[i]
				? ', cited passage marked'
				: ''}"
			style:aspect-ratio="1 / {sheet.ratio}"
		>
			<canvas bind:this={canvasEls[i]} aria-hidden="true"></canvas>
			{#if !drawn[i]}
				<span class="pdf__num" aria-hidden="true">Page {i + 1}</span>
			{/if}
			<!-- A page that failed to draw shows no marks or bar: they would mark an empty box. -->
			{#each broken[i] ? [] : sheet.marks as mark, m (m)}
				<div
					class="pdf__mark"
					aria-hidden="true"
					style:left="{mark.x * 100}%"
					style:top="{mark.y * 100}%"
					style:width="{mark.width * 100}%"
					style:height="{mark.height * 100}%"
				></div>
			{/each}
			{#if sheet.bar && !broken[i]}
				<div
					class="pdf__bar"
					aria-hidden="true"
					style:top="{sheet.bar.top * 100}%"
					style:height="{sheet.bar.height * 100}%"
				></div>
			{/if}
		</div>
		<!-- Only when something was cited: a document opened whole has no passage, and the line would name none. -->
		{#if i + 1 === passageAfter && (quoted ? quote : anchor)}
			<p class="pdf__passage">Cited passage: {quoted ? quote : anchor}</p>
		{/if}
	{/each}
</div>

<style>
	.pdf {
		width: 100%;
	}
	/* The line sits at the top of the box, not its middle: the box is a page tall, so a centred line starts
	   below the fold on a phone. A letter page's proportions until the real page is known. The muted-on-bg
	   pair is the one the reader's neutral note already uses, so its contrast is an established pair. */
	.pdf__ph {
		box-sizing: border-box;
		width: 100%;
		aspect-ratio: 1 / 1.294;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: var(--space-s);
		padding: var(--space-xxl) var(--space-l) 0;
		text-align: center;
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		background: var(--color-bg);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-s);
	}
	/* The Documents area's progress line: accent on the border colour, drawn from a native progress bar. */
	.pdf__load {
		appearance: none;
		display: block;
		width: 60%;
		height: 4px;
		border: none;
		border-radius: 2px;
		overflow: hidden;
		background: var(--color-border);
	}
	.pdf__load::-webkit-progress-bar {
		background: var(--color-border);
	}
	.pdf__load::-webkit-progress-value {
		background: var(--color-accent);
	}
	.pdf__load::-moz-progress-bar {
		background: var(--color-accent);
	}
	/* A page not yet drawn shows the loading box's ground and its number; the outline draws no layout. */
	.pdf__page {
		position: relative;
		width: 100%;
		margin: 0 0 var(--space-m);
		background: var(--color-bg);
		box-shadow: 0 0 0 1px var(--color-border);
	}
	.pdf__page:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 3px;
	}
	.pdf__page canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	.pdf__num {
		position: absolute;
		top: var(--space-xxl);
		left: 0;
		right: 0;
		text-align: center;
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	/* Twice the text view's tint, because this one always lies on a white page, where the text view's 16%
	   reads faint. Black text under it still measures about 10:1 against the tinted ground in both themes. */
	.pdf__mark {
		position: absolute;
		background: color-mix(in srgb, var(--color-accent) 32%, transparent);
		border-radius: 2px;
		pointer-events: none;
	}
	/* The whole passage's extent, in the page's left margin - the page view's echo of the text view's left
	   bar. A tint alone is faint on a white page, and marks nothing when the passage fills it. */
	.pdf__bar {
		position: absolute;
		left: 3.2%;
		width: 4px;
		background: var(--color-accent);
		border-radius: 2px;
		pointer-events: none;
	}
	/* A canvas is opaque to assistive technology, so the cited text is also present as text, visually
	   hidden. The same rule several components already carry locally. */
	.pdf__passage {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
