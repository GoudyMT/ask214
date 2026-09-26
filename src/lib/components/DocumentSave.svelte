<script lang="ts">
	import { tick } from 'svelte';
	import { CORPUS_BASE, CORPUS_BYTES, documentSourceId } from '$lib/ask/asset-cache';
	import {
		isAnswerLibraryHeld,
		listCachedDocuments,
		runningSave,
		saveDocument,
		type SaveResult
	} from '$lib/sources/document-cache';
	import { documentStates } from '$lib/sources/document-states';

	// The reader's own Save. Viewing a document keeps nothing on the device, so this is how a document opened
	// from an answer is kept for offline use. What the device holds, and the connection, are read when the
	// document opens, as the page view reads them.
	let {
		path,
		bytes,
		list = listCachedDocuments,
		save = saveDocument,
		running = runningSave,
		isOnline = () => navigator.onLine,
		libraryHeld = () => isAnswerLibraryHeld(CORPUS_BASE),
		recheck,
		onshow
	}: {
		// The document's current served path.
		path: string;
		bytes: number;
		// Injected by tests; the real cache, saves and connection state by default.
		list?: () => Promise<string[]>;
		save?: (path: string, stale: readonly string[]) => Promise<SaveResult>;
		running?: (path: string) => Promise<SaveResult> | undefined;
		isOnline?: () => boolean;
		libraryHeld?: () => Promise<boolean>;
		// Changed by the reader when the answer library may have been stored since it was read - the view
		// switched, or the text built - so it is read again.
		recheck?: string;
		// Called once it shows what it read from the device, so the reader can give focus back to it.
		onshow?: () => void;
	} = $props();

	// The Documents area's words for the same failures, so a failed save reads the same wherever it happens.
	const NOT_SAVED = {
		offline: 'Not saved - no connection.',
		quota: 'Not saved - this device is out of storage.',
		failed: 'Not saved - the download failed. Try again.'
	};

	let status = $state<'checking' | 'offer' | 'saving' | 'saved' | 'none'>('checking');
	// The held older copies of this document, cleared with the save once the new copy is stored. Plain, not
	// state: only the save reads it, when pressed.
	let stale: string[] = [];
	let failure = $state<keyof typeof NOT_SAVED | null>(null);
	let doneEl = $state<HTMLElement>();
	// The document this Save shows. Plain, not a prop read: a save can end after the reader has closed, when the
	// prop no longer has a document to read.
	let showing = '';
	// Counts the reads of the device. A read that ends after a newer one began, or after the Save is gone, is
	// dropped - even one for the same document, when the Save was given another and then this one again.
	let reads = 0;
	// A first save also stores the answer library while it is missing, so a saved document's text opens offline;
	// the Save says so, with its size. Nothing is said until the device has answered.
	let libraryMissing = $state(false);
	$effect(() => {
		void recheck;
		const read = libraryHeld;
		let current = true;
		void read().then((held) => {
			if (current) libraryMissing = !held;
		});
		return () => {
			current = false;
		};
	});

	$effect(() => {
		const current = path;
		const read = list;
		const online = isOnline;
		// A save of this document already running - this Save was built again while it ran - is shown, never
		// offered a second time.
		const pending = running(current);
		const mine = ++reads;
		showing = current;
		status = pending ? 'saving' : 'checking';
		failure = null;
		void read().then(async (cached) => {
			if (mine !== reads) return;
			const sourceId = documentSourceId(current);
			const held = documentStates(cached, { [sourceId]: current })[sourceId];
			stale = held?.stale ?? [];
			if (pending) return;
			// Offline, a document not saved cannot be saved now, so nothing is offered.
			status = held?.state === 'saved' ? 'saved' : online() ? 'offer' : 'none';
			await tick();
			onshow?.();
		});
		void pending?.then((result) => settle(current, result));
		return () => {
			reads += 1;
		};
	});

	// A press while a save runs does nothing, so a save never starts twice. The button stays focusable meanwhile
	// rather than disabled: a disabled button drops the focus it holds.
	async function keep(): Promise<void> {
		if (status === 'saving') return;
		const current = path;
		status = 'saving';
		failure = null;
		await settle(current, await save(current, stale));
	}

	async function settle(current: string, result: SaveResult): Promise<void> {
		// The reader moved on to another document while this one saved, or closed; what was saved stays.
		if (current !== showing) return;
		if (result === 'saved') {
			status = 'saved';
			// The pressed button is gone, and focus fell with it: it goes to the line that took the button's
			// place, which says the save worked. Only when focus was lost, so a user who moved on while the
			// save ran stays where they are, and without scrolling: the reader may have scrolled on meanwhile.
			await tick();
			if (document.activeElement === document.body) doneEl?.focus({ preventScroll: true });
			return;
		}
		status = 'offer';
		if (result !== 'stopped') failure = result;
	}
</script>

{#if status === 'saved'}
	<span class="save__done" tabindex="-1" data-refocus="save" bind:this={doneEl}
		>Saved on this device</span
	>
{:else if status === 'offer' || status === 'saving'}
	<button
		class="save"
		type="button"
		aria-disabled={status === 'saving'}
		data-refocus="save"
		onclick={keep}
		>{status === 'saving'
			? 'Saving...'
			: `Save for offline (${(bytes / 1e6).toFixed(1)} MB)`}</button
	>
	{#if failure}
		<!-- A failure, said as an alert as it appears: a polite line put in with its words already in it is not
		     always spoken. -->
		<span class="save__failed" role="alert">{NOT_SAVED[failure]}</span>
	{/if}
	{#if status === 'offer' && libraryMissing}
		<span class="save__line"
			>The first save also stores the answer library ({(CORPUS_BYTES / 1e6).toFixed(1)} MB), once.</span
		>
	{/if}
{/if}

<style>
	.save {
		background: none;
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-s);
		padding: 5px 12px;
		font: inherit;
		font-size: var(--font-size-s);
		font-weight: 600;
		color: var(--color-accent);
		cursor: pointer;
	}
	.save[aria-disabled='true'] {
		opacity: 0.6;
		cursor: default;
	}
	.save:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	/* A line of its own under the Save, in the foot's muted voice. */
	.save__line {
		flex-basis: 100%;
		margin-top: calc(-1 * var(--space-s));
		color: var(--color-fg-muted);
	}
	.save__done {
		color: var(--color-success);
		font-weight: 600;
	}
	/* The Documents area's failure colour: the app's attention colour, which holds contrast in both themes. */
	.save__failed {
		color: var(--color-danger);
		font-weight: 600;
	}
</style>
