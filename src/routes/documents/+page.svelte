<script lang="ts">
	import { onMount } from 'svelte';
	import DocumentsList from '$lib/components/DocumentsList.svelte';
	import SourceReader from '$lib/components/SourceReader.svelte';
	import { CORPUS_BASE, loadCorpus } from '$lib/ask/corpus-load';
	import { createLazyCorpus } from '$lib/ask/corpus-loader';
	import { sourcesFromCorpus, type Source } from '$lib/ask/sources';
	import { documentLibrary } from '$lib/sources/document-library';
	import {
		heldBytes,
		isAnswerLibraryHeld,
		isPdfLibraryHeld,
		listCachedDocuments,
		removeDocuments,
		runningSave,
		saveDocument,
		stopSave,
		stopSaves,
		type SaveResult
	} from '$lib/sources/document-cache';
	import { saveAll } from '$lib/sources/save-all.svelte';
	import { WEB_SOURCE_COUNT } from '$lib/sources/local-document-info.data';

	// What the asset cache holds. It is read again after every change rather than updated by hand, so the
	// list can only ever show what is really on the device.
	let cached = $state<string[]>([]);
	// Read with the rest: opening a document's text online stores the library, so it can arrive at any time. Null
	// until the read lands: nothing is said of the library, held or missing, before the device has answered.
	let libraryHeld = $state<boolean | null>(null);
	// The page reader a first save also stores; a save or an opened document stores it.
	let readerHeld = $state(true);
	let online = $state(true);
	let busy = $state<string[]>([]);
	let failed = $state<Record<string, 'offline' | 'quota' | 'failed'>>({});
	let opened = $state<{ sourceId: string; title: string } | null>(null);

	const library = $derived(documentLibrary(cached));

	// The older copies an update left, sized from the device: no size table knows a version no longer shipped.
	// Their size is null when the device would not give it.
	let older = $state<{ count: number; bytes: number | null }>({ count: 0, bytes: 0 });
	$effect(() => {
		const stale = library.flatMap((doc) => doc.stale);
		let cancelled = false;
		void heldBytes(stale).then((bytes) => {
			if (!cancelled) older = { count: stale.length, bytes };
		});
		return () => {
			cancelled = true;
		};
	});

	async function refresh(): Promise<void> {
		[cached, libraryHeld, readerHeld] = await Promise.all([
			listCachedDocuments(),
			isAnswerLibraryHeld(CORPUS_BASE),
			isPdfLibraryHeld()
		]);
	}

	// A save started before the page opened - in the reader on the Ask page, whose link leads here - can still be
	// running. Its row shows it running, so it is neither offered again nor saved twice by Save all, and the list
	// is read again when it lands.
	onMount(() => {
		for (const doc of library) {
			const running = runningSave(doc.path);
			if (running) void track(doc.sourceId, running);
		}
	});

	onMount(() => {
		const update = () => (online = navigator.onLine);
		update();
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});

	// On arrival, and each time a save-all run stores a document or ends, what is saved has changed.
	$effect(() => {
		void saveAll.done;
		void saveAll.running;
		void refresh();
	});

	async function save(sourceId: string): Promise<void> {
		const doc = library.find((d) => d.sourceId === sourceId);
		if (doc === undefined || busy.includes(sourceId)) return;
		await track(sourceId, saveDocument(doc.path, doc.stale));
	}

	// A document's own save, from its row or from the reader: its row shows it running, then why it failed.
	async function track(sourceId: string, run: Promise<SaveResult>): Promise<void> {
		busy = [...busy, sourceId];
		failed = Object.fromEntries(Object.entries(failed).filter(([id]) => id !== sourceId));
		const result = await run;
		busy = busy.filter((id) => id !== sourceId);
		if (result !== 'saved' && result !== 'stopped') failed = { ...failed, [sourceId]: result };
		await refresh();
	}

	// The row's own save, if one is running, is stopped and waited out first, or it puts the document back.
	async function remove(sourceId: string): Promise<void> {
		const doc = library.find((d) => d.sourceId === sourceId);
		if (doc === undefined) return;
		await stopSave(doc.path);
		await removeDocuments([doc.path, ...doc.stale]);
		await refresh();
	}

	// A document whose own save is in progress is left out: that save already brings it.
	function saveRemaining(): void {
		const items = library
			.filter((d) => d.state !== 'saved' && !busy.includes(d.sourceId))
			.map((d) => ({ path: d.path, stale: d.stale, bytes: d.bytes }));
		void saveAll.start(items);
	}

	// Every held document goes, older copies included. A save still writing would put its document straight
	// back, so every save is stopped and waited out first, and what goes is what the cache holds after that. A
	// Save all run ends with the saves it waits on, so it has ended by then; what it saved is now gone, so why it
	// stopped - here or earlier - is forgotten.
	async function removeAll(): Promise<void> {
		await stopSaves();
		saveAll.clear();
		await removeDocuments(await listCachedDocuments());
		await refresh();
	}

	// The reader's text view comes from the corpus, loaded only when a document's text is asked for.
	let sources = new Map<string, Source>();
	const getCorpus = createLazyCorpus(
		() => loadCorpus(fetch, CORPUS_BASE),
		(corpus) => {
			sources = sourcesFromCorpus(corpus);
		}
	);
	async function loadSource(sourceId: string): Promise<Source | null> {
		await getCorpus();
		return sources.get(sourceId) ?? null;
	}

	function open(sourceId: string): void {
		const doc = library.find((d) => d.sourceId === sourceId);
		if (doc !== undefined) opened = { sourceId, title: doc.title };
	}

	// The reader's own Save can store the document, so the list is read again when the reader closes, and again
	// when a save it started lands after that.
	function close(): void {
		const doc = library.find((d) => d.sourceId === opened?.sourceId);
		opened = null;
		const running = doc && runningSave(doc.path);
		if (running) void track(doc.sourceId, running);
		else void refresh();
	}
</script>

<svelte:head>
	<title>Documents - Ask 214</title>
</svelte:head>

<h1>Documents</h1>
<p class="documents-lede">
	The official guides behind Ask 214's answers. Open one to read it whole; save it to read it
	without a connection.
</p>

<DocumentsList
	rows={library}
	{online}
	{libraryHeld}
	libraryMissing={!readerHeld}
	{older}
	webSources={WEB_SOURCE_COUNT}
	progress={saveAll}
	{busy}
	{failed}
	onopen={open}
	onsave={(sourceId) => void save(sourceId)}
	onremove={(sourceId) => void remove(sourceId)}
	onsaveall={saveRemaining}
	onstop={() => saveAll.stop()}
	onremoveall={() => void removeAll()}
/>

<SourceReader source={null} doc={opened} {loadSource} onClose={close} />

<style>
	.documents-lede {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		margin: 0 0 var(--space-l);
	}
</style>
