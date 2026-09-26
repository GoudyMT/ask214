<script lang="ts">
	import { tick } from 'svelte';
	import type { Source } from '$lib/ask/sources';
	import { resolve } from '$app/paths';
	import type SourceDocumentView from './SourceDocument.svelte';
	import type { PassageNote } from './SourceDocument.svelte';
	import type DocumentPagerView from './DocumentPager.svelte';
	import type DocumentSaveView from './DocumentSave.svelte';
	import { documentUrl } from '$lib/sources/document-url';
	import { localDocumentPath, localDocumentSize } from '$lib/sources/local-document';
	import type { PdfRuntime } from '$lib/sources/pdf-runtime';

	// Opens the modal for any of: a loaded `source`, a `loading` fetch in progress, or an `error`. The
	// corpus IS the on-device reference library; this shows all the official text held locally for one
	// source, offline. loading/error give the "Read more" click immediate feedback while the corpus (which
	// is fetched on demand) loads, so the click is never a silent dead button.
	let {
		source,
		highlightId = null,
		loading = false,
		error = false,
		online = false,
		doc = null,
		loadSource,
		onClose,
		pdfLoader
	}: {
		source: Source | null;
		highlightId?: string | null;
		loading?: boolean;
		error?: boolean;
		// True when the answer came from the online path. Its source is then the passage the answer found,
		// not the corpus's whole text, and the on-device / no-connection reassurance does not apply.
		online?: boolean;
		// A served document opened whole, from the Documents area, with no answer behind it: it opens at its
		// first page with nothing cited, and its text is built only if the user asks for it.
		doc?: { sourceId: string; title: string } | null;
		// Builds `doc`'s text view. It reads the corpus, which is large on a first load, so it runs on demand.
		loadSource?: (sourceId: string) => Promise<Source | null>;
		onClose: () => void;
		// Replaces the PDF library in tests, as the page view's own loader does. Unset in the app.
		pdfLoader?: () => Promise<PdfRuntime>;
	} = $props();

	let dialogEl = $state<HTMLDialogElement>();
	let citedEl = $state<HTMLElement>();
	let errorEl = $state<HTMLElement>();

	const isOpen = $derived(source !== null || doc !== null || loading || error);

	// The text a whole document shows once built, and whether building it is under way or has failed.
	let built = $state<Source | null>(null);
	let building = $state<'idle' | 'loading' | 'failed'>('idle');
	const textSource = $derived(source ?? built);
	const title = $derived(source?.title ?? doc?.title ?? '');

	// Where the link out goes. `source.url` is the source's registry url, which for a TAP guide is the
	// shared library DIRECTORY page - the same on all 21 guides - so using it would walk the reader from
	// the exact highlighted passage back to a list of documents. Resolve the guide itself and anchor the
	// highlighted passage's own page. An html source keeps its url, which already IS the document. The
	// empty string is unreachable: the link renders only inside `{#if source}`.
	const officialUrl = $derived(
		source !== null
			? (documentUrl(source.sourceId, source.passages.find((p) => p.id === highlightId)?.page) ??
					source.url)
			: doc !== null
				? (documentUrl(doc.sourceId) ?? '')
				: ''
	);
	// A source with no document url is a web page: the registry requires one on every PDF entry and the
	// generator refuses to build without it, so only a web page has none. A `doc` is always a served PDF.
	const webPage = $derived(source !== null && documentUrl(source.sourceId) === undefined);

	// The body has two views of the same source: the page of the served document, and the text. A served
	// copy exists only for a PDF source, and the page view needs the cited page to open at, so without
	// both the reader is the text view alone, as it always was.
	const cited = $derived(source?.passages.find((p) => p.id === highlightId));
	const served = $derived.by(() => {
		// A document opened whole starts at its first page with no passage to find.
		const opened =
			source !== null
				? cited?.page === undefined
					? null
					: { sourceId: source.sourceId, page: cited.page, whole: false }
				: doc !== null
					? { sourceId: doc.sourceId, page: 1, whole: true }
					: null;
		if (opened === null) return null;
		const path = localDocumentPath(opened.sourceId);
		const bytes = localDocumentSize(opened.sourceId);
		return path !== undefined && bytes !== undefined ? { ...opened, path, bytes } : null;
	});
	let chosen = $state<'page' | 'text' | null>(null);
	// The pager's view of the page view: the page on screen, the page count once a page has loaded (no
	// pager until then), and the last page it asked for.
	let pagerPage = $state(1);
	let pagerCount = $state<number | null>(null);
	let pageRequest = $state<{ page: number } | null>(null);
	let fallback = $state<'offline' | 'updated' | 'failed' | null>(null);
	// What the page view found about the passage, pinned above the scroll so it stays in sight.
	let note = $state<PassageNote | null>(null);
	// The page first; the text when the user picks it, or when the page cannot be had.
	const view = $derived(served === null || fallback !== null ? 'text' : (chosen ?? 'page'));

	// Every new source opens on its page again, with nothing carried over from the last one.
	$effect(() => {
		void source;
		void doc;
		chosen = null;
		fallback = null;
		built = null;
		pagerPage = 1;
		pagerCount = null;
		pageRequest = null;
		note = null;
		building = 'idle';
		textAt = 0;
	});

	// A whole document's text is built the first time its text view is on screen, and never before.
	$effect(() => {
		if (source !== null || doc === null || view !== 'text') return;
		if (built !== null || building !== 'idle') return;
		const sourceId = doc.sourceId;
		if (loadSource === undefined) {
			building = 'failed';
			return;
		}
		building = 'loading';
		loadSource(sourceId)
			.then((loaded) => {
				if (doc?.sourceId !== sourceId) return;
				built = loaded;
				building = loaded === null ? 'failed' : 'idle';
			})
			.catch(() => {
				if (doc?.sourceId === sourceId) building = 'failed';
			});
	});

	// The page view carries the matcher and the viewer, so it is loaded only when a served document is
	// opened, never with the Ask page. The pager and the foot's Save come with it: both exist only for a
	// served document.
	let DocumentView = $state<typeof SourceDocumentView | null>(null);
	let Pager = $state<typeof DocumentPagerView | null>(null);
	let Save = $state<typeof DocumentSaveView | null>(null);
	$effect(() => {
		if (served === null || DocumentView !== null) return;
		void import('./reader-parts')
			.then((parts) => {
				DocumentView = parts.SourceDocument;
				Pager = parts.DocumentPager;
				Save = parts.DocumentSave;
			})
			.catch(() => {
				fallback = 'failed';
			});
	});

	// Sync the native dialog's open-state. showModal() (not the `open` attribute) is what gives the
	// focus-trap + Esc + backdrop the modal lock calls for.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (isOpen && !el.open) {
			el.showModal();
			landingFrom = document.activeElement;
		} else if (!isOpen && el.open) el.close();
	});

	// A landing takes focus only while focus is where it was when the landing was asked for - the reader opening,
	// or a view picked - or has fallen to the page, or is already in the view landed on. A user who moved on while
	// a document loaded is not pulled back.
	let landingFrom: Element | null = null;
	function mayLand(where: string): boolean {
		const active = document.activeElement;
		return (
			active === landingFrom ||
			active === document.body ||
			!!dialogEl?.querySelector(where)?.contains(active)
		);
	}
	const mayFocusPages = () => mayLand('.reader__doc');

	// A short screen - a phone turned sideways - leaves the pinned parts no room around the pages, so there the
	// switch, the note and the foot scroll with the document, inside the body; the title bar, a web page's line and
	// the page bar stay pinned. The body stays the one thing that scrolls, so the page view's landing and tracking
	// and the place each view keeps are unchanged. The query is the styles' own.
	let short = $state(false);
	// The switch, the note and the foot are built again in their other place, and a control holding focus goes
	// with them. Focus goes back to the same control: each carries a name of its own in `data-refocus`, which its
	// rebuilt twin carries too. The Save shows only once it has read the device, so it calls back when it does.
	// Only while focus is still lost: a user who moved on is not pulled back.
	let lost: string | undefined;
	function restore(): void {
		if (lost && document.activeElement !== document.body) lost = undefined;
		const control = lost && dialogEl?.querySelector<HTMLElement>(`[data-refocus="${lost}"]`);
		if (!control) return;
		lost = undefined;
		// On a short screen the control sits above the document in the scroll; the reader's place stays put.
		control.focus({ preventScroll: true });
	}
	$effect(() => {
		const query = window.matchMedia('(max-height: 500px)');
		const update = () => {
			const active = document.activeElement;
			lost =
				active instanceof HTMLElement && dialogEl?.contains(active)
					? active.dataset.refocus
					: undefined;
			short = query.matches;
			void tick().then(restore);
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// Both views scroll in the one body, so each keeps its own place. The page view keeps its own, as a page and
	// a point on it, and goes back to it when shown. The text's is saved at a switch away from it and put back
	// when it is shown again. It is read at the switch, before the text is hidden, because hiding it changes the
	// body's height and with it the scroll. This runs before the text's landing below, which still lands on its
	// cited passage.
	let bodyEl = $state<HTMLElement>();
	let textAt = 0;
	function pick(next: 'page' | 'text'): void {
		if (bodyEl && view === 'text') textAt = bodyEl.scrollTop;
		landingFrom = document.activeElement;
		chosen = next;
	}
	$effect(() => {
		if (bodyEl && view === 'text') bodyEl.scrollTop = textAt;
	});

	// Once content is present, land on the cited passage (focus + scroll) - runs on the null->source
	// transition too, so focus lands when a source resolves after the loading state. Instant, per the
	// app's low-motion default; block:'start' lands at the TOP of the (often taller-than-viewport) block.
	// Only while the text is the view on screen; it re-runs when the view switches to the text. The page
	// view lands on its own page.
	$effect(() => {
		if (source && dialogEl?.open && citedEl && view === 'text') {
			if (mayLand('.reader__text')) citedEl.focus({ preventScroll: true });
			// Refused focus, the text still goes to the passage - unless focus is in the scrolled body, on a control
			// the scroll would carry away from the user.
			else if (bodyEl?.contains(document.activeElement)) return;
			citedEl.scrollIntoView({ block: 'start' });
		}
	});

	// On failure, move focus to the alert message - matching the success path's focus move - so a screen
	// reader reliably hears the failure (the error is a fresh role="alert" node; focusing it is belt-and-braces).
	$effect(() => {
		if (error && dialogEl?.open && errorEl) errorEl.focus();
	});

	// Esc / backdrop fire the native `close` event without going through our button; tell the parent so
	// it resets state. Guard on isOpen so our own programmatic close() (state already cleared) is a no-op.
	function onNativeClose() {
		if (isOpen) onClose();
	}
	// A click whose target is the dialog element itself is a backdrop click (content clicks target children).
	function onBackdropClick(e: MouseEvent) {
		if (e.target === dialogEl) dialogEl?.close();
	}
</script>

<dialog
	bind:this={dialogEl}
	class="reader"
	aria-labelledby="ask-reader-title"
	onclose={onNativeClose}
	onclick={onBackdropClick}
>
	<!-- The title bar, in every state. -->
	{#snippet head(heading: string)}
		<div class="reader__head">
			<div>
				<p class="reader__src">Source</p>
				<h2 id="ask-reader-title" class="reader__title">{heading}</h2>
			</div>
			<button class="reader__close" type="button" aria-label="Close" onclick={onClose}
				>&times;</button
			>
		</div>
	{/snippet}
	{#if source || doc}
		<!-- The title bar and a web page's line are always pinned: Close stays in reach, and the line says why there is
		     no page view. On a short screen the switch, the note and the foot scroll with the document, the foot
		     first; elsewhere they are pinned around it. -->
		{#snippet controls()}
			{#if served}
				<!-- The app's segmented control (ThemeControl), so switching views feels like every other choice. -->
				<div class="reader__switch">
					<div class="seg" role="group" aria-label="Show">
						<button
							type="button"
							aria-pressed={view === 'page'}
							disabled={fallback !== null}
							data-refocus="page"
							onclick={() => pick('page')}>Page</button
						>
						<button
							type="button"
							aria-pressed={view === 'text'}
							data-refocus="text"
							onclick={() => pick('text')}>Text</button
						>
					</div>
				</div>
				<!-- In place, empty and taking no room, before there is anything to say, then filled: a status line put
				     in with its words already in it is not always spoken. -->
				<div class="reader__note" role="status">
					{#if note && view === 'page'}
						<p>
							{#if note.kind === 'elsewhere'}
								Cited as page {note.cited}. The passage starts on page {note.found}, marked below.
							{:else}
								The passage could not be marked on this page.
							{/if}
						</p>
						<button
							class="reader__act"
							type="button"
							data-refocus="act"
							onclick={() => pick('text')}>Show it in the text</button
						>
					{/if}
				</div>
			{/if}
		{/snippet}
		{#snippet pin()}
			{#if webPage}
				<!-- The text lands on the cited passage, often far down, so this line would scroll out of sight at the
				     top of the text. For a web page it says why there is no page view, so it stays pinned above. -->
				<div class="reader__pin">{@render held()}</div>
			{/if}
		{/snippet}
		{#snippet held()}
			<p class="reader__held" class:reader__held--neutral={online}>
				{online
					? 'Showing the passage this answer found'
					: 'Showing the text saved on your device'}{webPage
					? '. This source is a web page, so there is no document to open here - the link below goes to the live page.'
					: online
						? '. The whole text comes with the answer library Ask uses offline.'
						: ' - open the official site for the complete original.'}
			</p>
		{/snippet}
		{@render head(title)}
		{#if !short}
			{@render controls()}
		{/if}
		{@render pin()}
		<div class="reader__body" bind:this={bodyEl}>
			{#if short}
				{@render controls()}
				{@render foot()}
			{/if}
			<!-- Both views stay mounted and are toggled with `hidden`, so going back to the page does not
			     fetch and draw it again. -->
			{#if served && DocumentView}
				<!-- A stop in the tab order of its own, named, because the pages inside are not in it: each takes
				     focus only to land on it. Focused, the keys scroll the body that holds it. Not a widget, so the
				     compiler's rule against a tab stop on a non-interactive role does not fit; this is the scrollable
				     region pattern. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					class="reader__doc"
					role="region"
					aria-label="Document pages"
					tabindex="0"
					hidden={view !== 'page'}
				>
					<DocumentView
						path={served.path}
						bytes={served.bytes}
						{title}
						page={served.page}
						anchor={cited?.anchor ?? ''}
						passageText={cited?.text ?? ''}
						cited={!served.whole}
						mayFocus={mayFocusPages}
						onfallback={(reason) => (fallback = reason)}
						onnote={(found) => (note = found)}
						request={pageRequest}
						onview={(shownView) => {
							pagerPage = shownView.page;
							pagerCount = shownView.pages;
						}}
						{...pdfLoader ? { loader: pdfLoader } : {}}
					/>
				</div>
			{/if}
			<!-- A served document's text is a named stop of its own too, as the pages are: a whole document's text
			     lands on no passage, and WebKit's Tab passes over a scrolling box with nothing in it to focus. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="reader__text"
				role={served ? 'region' : undefined}
				aria-label={served ? 'Document text' : undefined}
				tabindex={served ? 0 : undefined}
				hidden={view !== 'text'}
			>
				{#if textSource && !webPage}
					{@render held()}
				{/if}
				<!-- Fresh nodes, said as alerts, as the error state's are: each takes the place of the pages the user
				     opened, and a polite line put in with its words already in it is not always spoken. -->
				{#if fallback === 'failed'}
					<!-- A document opened from the list shows its own text. An online answer's text is the passage the
					     search found; nothing of it is kept on the device. -->
					<div class="reader__notice" role="alert">
						The document could not be opened, so this is {served?.whole
							? 'its text'
							: online
								? 'the passage this answer found'
								: 'the text saved on your device'}.
					</div>
				{:else if fallback === 'updated'}
					<div class="reader__notice" role="alert">
						The new version of this document is not saved on this device. Save it again when you
						have a connection.
					</div>
				{:else if fallback === 'offline'}
					<div class="reader__notice" role="alert">
						This document is not saved on this device. Save it for offline use when you have a
						connection.
					</div>
				{/if}
				{#if textSource}
					<!-- index key: this list is replace-all re-rendered per source and never reordered, so the index
					     is stable and collision-proof; the highlight matches on passage.id === highlightId, not the key -->
					{#each textSource.passages as passage, i (i)}
						{#if passage.section && passage.section !== textSource.passages[i - 1]?.section}
							<h3 class="reader__section">{passage.section}</h3>
						{/if}
						{#if passage.page !== undefined && passage.page !== textSource.passages[i - 1]?.page}
							<p class="reader__page">Page {passage.page}</p>
						{/if}
						{#if passage.id === highlightId}
							<!-- the "Cited passage" label is a CSS ::before + aria-label (role=group), so it names the
							     region for a screen reader without joining the copyable text or double-announcing -->
							<p
								class="reader__passage reader__passage--cited"
								role="group"
								aria-label="Cited passage"
								tabindex="-1"
								bind:this={citedEl}
							>
								{passage.text}
							</p>
						{:else}
							<p class="reader__passage">{passage.text}</p>
						{/if}
					{/each}
				{:else if building === 'failed'}
					<p class="reader__status" role="alert">
						This source could not be loaded right now. Check your connection and try again.
					</p>
				{:else}
					<p class="reader__status" role="status">Loading the source...</p>
				{/if}
			</div>
		</div>
		{#if served && Pager && view === 'page' && pagerCount !== null}
			<Pager
				page={pagerPage}
				pageCount={pagerCount}
				onpage={(to) => {
					pagerPage = to;
					pageRequest = { page: to };
				}}
			/>
		{/if}
		{#if !short}
			{@render foot()}
		{/if}
		{#snippet foot()}
			<div class="reader__foot">
				{#if served && Save}
					<Save
						path={served.path}
						bytes={served.bytes}
						recheck={`${view} ${building}`}
						onshow={restore}
					/>
				{/if}
				<!-- external public-source citation (https), not internal SvelteKit nav; resolve() does not apply. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					class="reader__link"
					href={officialUrl}
					target="_blank"
					rel="noopener noreferrer"
					data-refocus="site">View on the official site</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<!-- Leaving closes the reader first, which is all the link does when the Documents page is already open. -->
				<a class="reader__link" href={resolve('/documents')} data-refocus="all" onclick={onClose}
					>All documents</a
				>
				<!-- True of the answer library's text only. A served document may not be saved, and its Save says what is kept. -->
				{#if !online && !served}
					<span class="reader__muted">Held on your device - no connection needed.</span>
				{/if}
			</div>
		{/snippet}
	{:else if loading || error}
		{@render head(loading ? 'Loading the source' : 'Source unavailable')}
		<div class="reader__body">
			<!-- Distinct nodes per state: loading->error inserts a FRESH role="alert" node (reliably
			     announced), rather than mutating a role="status" node's attribute in place. -->
			{#if loading}
				<p class="reader__status" role="status">
					{online ? 'Loading the source...' : 'Loading the source held on your device...'}
				</p>
			{:else}
				<p class="reader__status" role="alert" tabindex="-1" bind:this={errorEl}>
					This source could not be loaded right now. Check your connection and try again.
				</p>
			{/if}
		</div>
	{/if}
</dialog>

<style>
	.reader {
		width: min(720px, 92vw);
		max-height: 86vh;
		padding: 0;
		overflow: hidden;
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
	}
	/* Only an OPEN dialog lays out; a closed <dialog> keeps the UA display:none (no phantom bar in flow). */
	.reader[open] {
		display: flex;
		flex-direction: column;
	}
	/* While the reader is open the page behind it holds still, so a scroll moves the document, not the page.
	   Keyed on the open dialog itself, so every way of closing it (the button, Esc, the backdrop) releases it. */
	:global(html:has(dialog.reader[open])) {
		overflow: hidden;
	}
	.reader::backdrop {
		background: rgba(7, 10, 14, 0.66);
	}

	.reader__head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-m);
		padding: var(--space-l) var(--space-l) var(--space-m);
		border-bottom: 1px solid var(--color-border);
	}
	.reader__src {
		margin: 0 0 2px;
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.reader__title {
		margin: 0;
		font-size: var(--font-size-l);
		line-height: 1.25;
	}
	.reader__close {
		flex-shrink: 0;
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
	}

	.reader__body {
		flex: 1;
		overflow-y: auto;
		/* A scroll that reaches the end of the document stops there instead of passing to the page. */
		overscroll-behavior: contain;
		padding: var(--space-l);
	}
	/* Drawn inside each view: on a short screen the body has no room around the views, and it clips. */
	.reader__doc:focus-visible,
	.reader__text:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
	.reader__held {
		margin: 0 0 var(--space-l);
		padding: var(--space-xs) var(--space-m);
		font-size: var(--font-size-s);
		color: var(--color-success);
		background: var(--color-bg);
		border-left: 3px solid var(--color-success);
		border-radius: var(--radius-s);
	}
	/* Online answers did not earn the on-device privacy signal, so the note is neutral, not success green. */
	.reader__held--neutral {
		color: var(--color-fg-muted);
		border-left-color: var(--color-border);
	}
	.reader__status {
		margin: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.reader__switch {
		padding: var(--space-s) var(--space-l);
		border-bottom: 1px solid var(--color-border);
	}
	/* Pinned between the switch and the scroll, so what it says about the passage stays in sight. */
	.reader__note {
		padding: var(--space-s) var(--space-l);
		font-size: var(--font-size-s);
		background: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
	}
	.reader__note p {
		margin: 0;
	}
	.reader__note:empty {
		padding: 0;
		border: 0;
	}
	/* The same pinned strip, holding a web page's held line above the scroll. */
	.reader__pin {
		padding: var(--space-s) var(--space-l);
		border-bottom: 1px solid var(--color-border);
	}
	.reader__pin .reader__held {
		margin: 0;
	}
	.reader__act {
		margin-top: var(--space-xs);
		padding: 0;
		background: none;
		border: none;
		font: inherit;
		color: var(--color-accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.reader__act:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	/* The app's segmented control, as ThemeControl draws it. */
	.seg {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		overflow: hidden;
	}
	/* The focus ring sits on the container, outset, so the pill's rounded, clipped ends never cut it. */
	.seg:has(:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.seg button {
		border: none;
		background: transparent;
		color: var(--color-fg-muted);
		padding: 6px 15px;
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.seg button[aria-pressed='true'] {
		background: var(--color-accent);
		color: var(--color-bg);
	}
	.seg button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.reader__notice {
		margin: 0 0 var(--space-m);
		padding: var(--space-s) var(--space-m);
		font-size: var(--font-size-s);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
	}
	.reader__passage {
		margin: 0 0 var(--space-m);
		line-height: 1.65;
	}
	.reader__passage--cited {
		padding: var(--space-s) var(--space-m);
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-s);
		scroll-margin: var(--space-l) 0;
	}
	.reader__passage--cited:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	/* The label is generated content, so it is not selectable/copyable and stays out of the DOM text run. */
	.reader__passage--cited::before {
		content: 'Cited passage';
		display: block;
		margin-bottom: var(--space-xs);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-accent);
	}
	.reader__section {
		margin: var(--space-l) 0 var(--space-s);
		font-size: var(--font-size-base);
	}
	.reader__page {
		margin: var(--space-m) 0 var(--space-s);
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}

	.reader__foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		padding: var(--space-m) var(--space-l);
		font-size: var(--font-size-s);
		border-top: 1px solid var(--color-border);
	}
	.reader__link {
		color: var(--color-accent);
		text-decoration: none;
	}
	.reader__muted {
		color: var(--color-fg-muted);
	}

	/* phone: the reader is a full-screen reading sheet */
	@media (max-width: 600px), (max-height: 500px) {
		.reader {
			width: 100vw;
			max-width: 100vw;
			height: 100vh;
			max-height: 100vh;
			border: none;
			border-radius: 0;
		}
	}

	/* A short screen: the switch, the note and the foot are inside the body here (the script's query is this one),
	   so the body's padding moves onto the two views and those parts sit edge to edge as they do when pinned. The
	   pinned head keeps only the title, and the note one line, so the pages get more of the height. */
	@media (max-height: 500px) {
		.reader__body {
			padding: 0;
		}
		.reader__doc,
		.reader__text {
			padding: var(--space-l);
		}
		.reader__src {
			display: none;
		}
		.reader__head > div {
			min-width: 0;
		}
		.reader__title {
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		/* Narrow as well, as at 400% zoom, one line would cut most of the title: it wraps instead. */
		@media (max-width: 480px) {
			.reader__title {
				white-space: normal;
			}
		}
		.reader__note {
			display: flex;
			align-items: baseline;
			gap: var(--space-m);
		}
		.reader__note p {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.reader__note .reader__act {
			margin-top: 0;
			flex: none;
		}
		/* The foot sits above the document here, so its rule goes below it. */
		.reader__body > .reader__foot {
			border-top: none;
			border-bottom: 1px solid var(--color-border);
		}
	}
</style>
