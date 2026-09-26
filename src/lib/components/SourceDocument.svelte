<script lang="ts" module>
	/** What the reader says about an answer's passage: found on another page than cited, or found nowhere. */
	export type PassageNote =
		{ kind: 'elsewhere'; cited: number; found: number } | { kind: 'unmarked' };
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import PdfView from './PdfView.svelte';
	import { documentSourceId } from '$lib/ask/asset-cache';
	import { selectAnswer } from '$lib/ask/answer/select-answer';
	import { isDocumentSaved, listCachedDocuments } from '$lib/sources/document-cache';
	import { LOCAL_DOCUMENTS_WITH_PICTURES } from '$lib/sources/local-documents-with-pictures.data';
	import { loadPdfRuntime, type PdfRuntime } from '$lib/sources/pdf-runtime';

	// The reader's page view: the whole served document, scrolled, landing on the answer's passage with the
	// quoted text marked. It opens at once - viewing keeps nothing on the device, and the loading box states the
	// size while the file arrives - and it never leaves a dead end: a document that cannot be had (offline and
	// never saved, or failing to load) is handed back to the reader's text view.
	let {
		path,
		bytes,
		title,
		page,
		anchor,
		passageText,
		onfallback,
		cited = true,
		request = null,
		onview,
		onnote,
		mayFocus = () => true,
		isSaved = isDocumentSaved,
		isOnline = () => navigator.onLine,
		held = listCachedDocuments,
		loader = loadPdfRuntime
	}: {
		path: string;
		bytes: number;
		title: string;
		// The cited page, 1-based.
		page: number;
		// The stored anchor the page is searched for; empty when the chunk carries none.
		anchor: string;
		// The reader's passage text. Its opening window is the quote the answer block showed.
		passageText: string;
		// Why the text shows instead: offline with the document not saved - or with only an older copy of it saved,
		// an update since not yet - or the document would not open.
		onfallback: (reason: 'offline' | 'updated' | 'failed') => void;
		// False when the document was opened whole, with no passage to find: nothing is said about one.
		cited?: boolean;
		// A page the reader's pager asks for. Each request is a new object, so asking twice still moves.
		request?: { page: number } | null;
		// Told the page in view and the page count as the reader scrolls, so the pager can show them.
		onview?: (view: { page: number; pages: number }) => void;
		// Told what to say about the passage once it is located - or null when there is nothing to say.
		onnote?: (note: PassageNote | null) => void;
		// Asked as the page view lands whether the landing page may take focus; passed on as it is given.
		mayFocus?: () => boolean;
		// Injected by tests; the real cache, connection state and library by default.
		isSaved?: (path: string) => Promise<boolean>;
		isOnline?: () => boolean;
		held?: () => Promise<string[]>;
		loader?: () => Promise<PdfRuntime>;
	} = $props();

	let phase = $state<'checking' | 'view'>('checking');
	// The page the view lands on: the cited page, or where the passage starts when it was found on another.
	let landing = $state(0);
	// Plain, not state: read only when a page report is passed on, never by the markup or an effect.
	let pageCount = 0;
	// Whether the first report - the one for the cited page - has been read. Later reports are for the page the
	// view moved to, and say nothing new about where the passage is.
	let reported = false;

	const quote = $derived(selectAnswer(passageText));
	// A guide that kept the pictures whose own metadata states Public Domain is without most of its pictures, not
	// all of them.
	const somePictures = $derived(LOCAL_DOCUMENTS_WITH_PICTURES.includes(documentSourceId(path)));
	// The document and the cited page, compared by value: a props update that hands over the same ones - the
	// reader re-rendering to pass a page request - must not reset the landing or say the note again.
	const opened = $derived(`${path}\n${page}`);
	const savedCheck = $derived(isSaved);
	const onlineCheck = $derived(isOnline);

	$effect(() => {
		void opened;
		const target = untrack(() => ({ path, page }));
		const check = savedCheck;
		const online = onlineCheck;
		let cancelled = false;
		phase = 'checking';
		landing = target.page;
		pageCount = 0;
		reported = false;

		void check(target.path).then((saved) => {
			if (cancelled) return;
			if (saved || online()) {
				phase = 'view';
				return;
			}
			// Known before trying: a load that must fail offline would only delay the text the user can have now.
			// An older copy on the device means it was saved once and has been updated since.
			const id = documentSourceId(target.path);
			void held().then((paths) => {
				if (!cancelled)
					onfallback(paths.some((p) => documentSourceId(p) === id) ? 'updated' : 'offline');
			});
		});
		return () => {
			cancelled = true;
		};
	});

	// Where the passage is, read from the first report: marked on its cited page (nothing to say), found on
	// another page (land there, and name both pages so the citation stays honest), or found nowhere.
	function located(result: { marked: boolean; foundOn: number[]; pageCount: number }): void {
		pageCount = result.pageCount;
		if (reported) return;
		reported = true;
		if (!cited || result.marked) {
			onnote?.(null);
			return;
		}
		const found = result.foundOn[0];
		if (found !== undefined && !result.foundOn.includes(page)) {
			landing = found;
			onnote?.({ kind: 'elsewhere', cited: page, found });
		} else {
			onnote?.({ kind: 'unmarked' });
		}
	}
</script>

{#if phase === 'view'}
	<p class="doc__held">
		{somePictures
			? 'A copy of the official document, without most of its pictures.'
			: 'A copy of the official document, without its pictures.'}
	</p>
	<PdfView
		url={path}
		page={landing}
		{anchor}
		{quote}
		{title}
		{bytes}
		{loader}
		{request}
		{mayFocus}
		onfail={() => onfallback('failed')}
		onlocate={located}
		onpage={(n) => onview?.({ page: n, pages: pageCount })}
	/>
{/if}

<style>
	/* The reader's neutral held note: this line describes the document, it is not a privacy signal. */
	.doc__held {
		margin: 0 0 var(--space-m);
		padding: var(--space-xs) var(--space-m);
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		background: var(--color-bg);
		border-left: 3px solid var(--color-border);
		border-radius: var(--radius-s);
	}
</style>
