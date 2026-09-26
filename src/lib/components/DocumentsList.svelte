<script lang="ts" module>
	import type { DocumentState } from '$lib/sources/document-states';
	import type { StoppedBy } from '$lib/sources/save-all.svelte';
	import type { Publisher } from '$lib/sources/types';

	/** One served document as the list shows it. */
	export type DocumentRow = {
		sourceId: string;
		title: string;
		publisher: Publisher;
		pages: number;
		bytes: number;
		state: DocumentState;
	};

	/** A save-all run as the list shows it - the save-all store's own fields. */
	export type SaveProgress = {
		running: boolean;
		done: number;
		total: number;
		bytesDone: number;
		bytesTotal: number;
		stoppedBy: StoppedBy | null;
	};
</script>

<script lang="ts">
	import { resolve } from '$app/paths';
	import { CORPUS_BYTES } from '$lib/ask/asset-cache';
	import { LIBRARY_BYTES } from '$lib/sources/pdf-library-paths';

	// Every served document, what this device holds of it, and the actions on it. The list only shows state
	// and reports what the user asked for; the page does the saving and removing, then passes the new state.
	let {
		rows,
		online,
		libraryHeld = false,
		libraryMissing = false,
		older = { count: 0, bytes: 0 },
		webSources,
		progress,
		busy = [],
		failed = {},
		onopen,
		onsave,
		onremove,
		onsaveall,
		onstop,
		onremoveall
	}: {
		rows: readonly DocumentRow[];
		online: boolean;
		// Whether the answer library is on this device - null until the device has been read, when nothing is
		// said of it. A document's text comes from it, so offline the text of a document not saved opens only
		// when it is; a first save also stores it while it is not.
		libraryHeld?: boolean | null;
		// Whether the page reader - the PDF library a first save also stores - is missing from this device.
		libraryMissing?: boolean;
		// The older copies an update left on this device, and their stored size - null when the device would not
		// give it.
		older?: { count: number; bytes: number | null };
		// How many sources are web pages, which are never re-hosted and so are not listed here.
		webSources: number;
		progress: SaveProgress;
		// Documents whose own save is in progress.
		busy?: readonly string[];
		// Why a document's last own save failed, until it is tried again.
		failed?: Readonly<Record<string, 'offline' | 'quota' | 'failed'>>;
		onopen: (sourceId: string) => void;
		onsave: (sourceId: string) => void;
		onremove: (sourceId: string) => void;
		onsaveall: () => void;
		onstop: () => void;
		onremoveall: () => void;
	} = $props();

	const STOPPED: Record<StoppedBy, string> = {
		user: 'What is saved stays.',
		offline: 'The connection dropped; what is saved stays.',
		quota: 'This device is out of storage; what is saved stays.',
		failed: 'A document could not be downloaded; what is saved stays.'
	};
	const NOT_SAVED = {
		offline: 'Not saved - no connection.',
		quota: 'Not saved - this device is out of storage.',
		failed: 'Not saved - the download failed. Try again.'
	};

	const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
	const sum = (list: readonly DocumentRow[]) => list.reduce((total, row) => total + row.bytes, 0);
	const documents = (count: number) => (count === 1 ? 'document' : 'documents');
	const copies = (count: number) => `${count} older ${count === 1 ? 'copy' : 'copies'}`;

	// An updated document's new version is not held, so it waits among the documents still to save.
	const saved = $derived(rows.filter((row) => row.state === 'saved'));
	const remaining = $derived(rows.filter((row) => row.state !== 'saved'));
	// Save all leaves out a document whose own save is in progress: that save already brings it.
	const toSave = $derived(remaining.filter((row) => !busy.includes(row.sourceId)));
	// Remove all takes the older copies too, so what it frees counts them - and is unknown, so left unsaid, while
	// their size is.
	const frees = $derived(older.bytes === null ? null : sum(saved) + older.bytes);
	// What a first save stores besides its document, named with its size while it is missing from this device.
	const firstSave = $derived(
		libraryMissing && libraryHeld === false
			? ` The first save also stores the page reader and the answer library (${mb(LIBRARY_BYTES + CORPUS_BYTES)}), once, so their text opens offline too.`
			: libraryMissing
				? ` The first save also stores the page reader (${mb(LIBRARY_BYTES)}), once.`
				: libraryHeld === false
					? ` The first save also stores the answer library (${mb(CORPUS_BYTES)}), once, so their text opens offline too.`
					: ''
	);

	// Plain, not state: both dialogs are always drawn, and only the buttons that open and close them read these.
	let saveDialog: HTMLDialogElement | undefined;
	let removeDialog: HTMLDialogElement | undefined;

	// The list's own control that last held focus, and the id of its row's title when it is in a row. A control
	// can go while it holds focus: a row moving to the other group is built anew, and a run starting or ending
	// swaps Save all, Stop and Remove all. Plain, not state: nothing is drawn from them.
	let root: HTMLElement | undefined;
	let countLine: HTMLElement | undefined;
	let focused: HTMLElement | null = null;
	let focusedRow: string | null = null;

	function remember(event: FocusEvent): void {
		const target = event.target as HTMLElement;
		focused = target;
		focusedRow = target.closest('.doc-row')?.querySelector('.doc-row__title')?.id ?? null;
	}

	// Once the control holding focus is gone or disabled and focus has fallen to the page, it goes to that row's
	// title in its new place, or to the count when the control had no row, without scrolling the view. What
	// takes focus is then the control remembered, so it moves once. Focus the user moved anywhere else, and a
	// control still there, are left alone.
	function keep(): void {
		const lost = focused;
		if (lost === null || (lost.isConnected && !lost.matches(':disabled'))) return;
		if (document.activeElement !== document.body) return;
		const title = focusedRow === null ? null : document.getElementById(focusedRow);
		(title ?? countLine)?.focus({ preventScroll: true });
	}

	// Measured in both engines: WebKit sends no focusout when the focused control is removed, so every change to
	// the list is checked. A disabled control, and a dialog closing onto a title built anew, lose focus with a
	// focusout - a frame later in WebKit - so that is checked too.
	$effect(() => {
		const observer = new MutationObserver(keep);
		if (root) observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	});
</script>

<svelte:document onfocusout={keep} />

{#snippet documentRow(row: DocumentRow)}
	{@const reason = failed[row.sourceId]}
	<li class="doc-row">
		<div class="doc-row__main">
			<button
				class="doc-row__title"
				id="doc-{row.sourceId}"
				type="button"
				onclick={() => onopen(row.sourceId)}>{row.title}</button
			>
			<span class="doc-row__meta">
				{#if row.state === 'saved'}
					<span class="doc-row__saved">Saved</span> -
				{:else if row.state === 'updated'}
					<span class="doc-row__updated">Updated - the new version is not saved</span> -
				{/if}
				{row.publisher} - {row.pages}
				{row.pages === 1 ? 'page' : 'pages'} - {mb(row.bytes)}
			</span>
			<!-- A live region there before its words, and empty until then: one inserted with its words already in it
			     may not be spoken. -->
			<span role="status"
				>{#if reason}<span class="doc-row__meta doc-row__failed">{NOT_SAVED[reason]}</span
					>{/if}</span
			>
		</div>
		<div class="doc-row__act">
			{#if row.state === 'saved'}
				<button class="btn-quiet" type="button" onclick={() => onremove(row.sourceId)}
					>Remove</button
				>
			{:else if progress.running}
				<!-- The run in progress saves it, or its own save already is. -->
			{:else if row.state === 'updated'}
				<!-- The older copy stays until it is saved again or removed, so it can be removed on its own - offline
				     too. Its Remove does not move the row, so focus goes to the row's title as the button goes. -->
				<span class="doc-row__acts">
					{@render saveAction(row)}
					<button
						class="btn-quiet"
						type="button"
						onclick={() => {
							onremove(row.sourceId);
							document.getElementById(`doc-${row.sourceId}`)?.focus();
						}}>Remove</button
					>
				</span>
			{:else}
				{@render saveAction(row)}
			{/if}
		</div>
	</li>
{/snippet}

{#snippet saveAction(row: DocumentRow)}
	{#if online}
		<!-- Marked unavailable while its save runs, not disabled: a disabled button drops focus. -->
		<button
			class="btn-outline"
			type="button"
			aria-disabled={busy.includes(row.sourceId)}
			onclick={() => {
				if (!busy.includes(row.sourceId)) onsave(row.sourceId);
			}}>{row.state === 'updated' ? 'Save again' : 'Save'}</button
		>
	{:else}
		<span class="doc-row__meta">Needs a connection</span>
	{/if}
{/snippet}

<!-- The list whose focus is kept. The dialogs sit outside it: closing one gives focus back to the control that
     opened it, which the list then keeps. -->
<div bind:this={root} onfocusin={remember}>
	<div class="docs-sum">
		<!-- A live region, so a save or a removal is heard in the words the screen already shows. Focus comes here
		     when the control holding it goes and has no row to go to. -->
		<span class="docs-sum__count" role="status" tabindex="-1" bind:this={countLine}
			>{saved.length} of {rows.length} saved on this device - {mb(sum(saved))}{older.count > 0
				? `, plus ${copies(older.count)}${older.bytes === null ? '' : ` (${mb(older.bytes)})`}`
				: ''}</span
		>
		{#if toSave.length > 0 && !progress.running}
			<button
				class="btn-outline"
				type="button"
				disabled={!online}
				onclick={() => saveDialog?.showModal()}
				>Save {toSave.length} remaining ({mb(sum(toSave))})</button
			>
		{/if}
	</div>
	<p class="docs-sum__note">
		Saved documents open without a connection and stay until you remove them.
		{#if !online}
			You are offline: documents not saved yet cannot be saved now{libraryHeld
				? ', but their text still opens'
				: ''}.
		{/if}
	</p>

	<!-- The run's live region, there and empty before a run starts, as a row's is. -->
	<div role="status">
		{#if progress.running}
			<div class="progress">
				Saving {progress.done} of {progress.total} - {mb(progress.bytesDone)} of {mb(
					progress.bytesTotal
				)}
				<progress
					class="progress__bar"
					max={progress.total}
					value={progress.done}
					aria-hidden="true"
				></progress>
				<button class="btn-link" type="button" onclick={onstop}>Stop</button>
				<span class="progress__keep">(what is already saved stays)</span>
			</div>
		{:else if progress.stoppedBy !== null}
			<p class="progress">
				Stopped - {progress.done} of {progress.total} saved. {STOPPED[progress.stoppedBy]}
			</p>
		{/if}
	</div>

	{#if saved.length > 0}
		<div class="docs-group">
			<h2 class="docs-group__head">Saved ({saved.length})</h2>
			<ul class="docs-rows">
				{#each saved as row (row.sourceId)}
					{@render documentRow(row)}
				{/each}
			</ul>
		</div>
	{/if}
	{#if remaining.length > 0}
		<div class="docs-group">
			<h2 class="docs-group__head">Not saved ({remaining.length})</h2>
			<ul class="docs-rows">
				{#each remaining as row (row.sourceId)}
					{@render documentRow(row)}
				{/each}
			</ul>
		</div>
	{/if}

	{#if saved.length > 0 || older.count > 0}
		<div class="docs-foot">
			<button class="danger-cta" type="button" onclick={() => removeDialog?.showModal()}
				>Remove all saved documents</button
			>
			<p class="docs-hint">
				{frees === null ? '' : `Frees ${mb(frees)}. `}The search model, the answer library and your
				data stay.
			</p>
		</div>
	{/if}

	<p class="docs-web">
		{webSources} more sources are web pages, read on their official sites.
		<a href={resolve('/about')}>See them all on About</a>
	</p>
</div>

<dialog
	bind:this={saveDialog}
	class="docs-dialog"
	aria-labelledby="docs-save-heading"
	aria-describedby="docs-save-body"
>
	<h2 id="docs-save-heading" class="docs-dialog__heading">
		Save {toSave.length} more {documents(toSave.length)}?
	</h2>
	<p id="docs-save-body" class="docs-dialog__body">
		They take {mb(sum(toSave))} and stay on this device until you remove them.{firstSave} If your data
		is limited, use Wi-Fi.
	</p>
	<div class="docs-dialog__actions">
		<button class="docs-dialog__quiet" type="button" onclick={() => saveDialog?.close()}
			>Cancel</button
		>
		<button
			class="docs-dialog__primary"
			type="button"
			onclick={() => {
				saveDialog?.close();
				onsaveall();
			}}>Save {toSave.length} {documents(toSave.length)}</button
		>
	</div>
</dialog>

<!-- The erase dialog's shape: Cancel is the prominent, focused default; the destructive action is quiet. -->
<dialog
	bind:this={removeDialog}
	class="docs-dialog"
	aria-labelledby="docs-remove-heading"
	aria-describedby="docs-remove-body"
>
	<h2 id="docs-remove-heading" class="docs-dialog__heading">Remove all saved documents?</h2>
	<p id="docs-remove-body" class="docs-dialog__body">
		{frees === null ? '' : `This frees ${mb(frees)}. `}The search model, the answer library and your
		data stay. You can save any document again with a connection.
	</p>
	<div class="docs-dialog__actions">
		<button class="docs-dialog__primary" type="button" onclick={() => removeDialog?.close()}
			>Cancel</button
		>
		<button
			class="docs-dialog__danger"
			type="button"
			onclick={() => {
				removeDialog?.close();
				onremoveall();
			}}
			>{older.count === 0
				? `Remove ${saved.length} ${documents(saved.length)}`
				: saved.length === 0
					? `Remove ${copies(older.count)}`
					: `Remove ${saved.length} ${documents(saved.length)} and ${copies(older.count)}`}</button
		>
	</div>
</dialog>

<style>
	.docs-sum {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s) var(--space-m);
		margin: 0 0 var(--space-s);
	}
	.docs-sum__count {
		font-weight: 600;
	}
	.docs-sum__note {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.btn-outline {
		background: none;
		border: 1px solid var(--color-accent);
		color: var(--color-accent);
		border-radius: var(--radius-s);
		padding: 6px var(--space-m);
		font: inherit;
		font-size: var(--font-size-s);
		font-weight: 600;
		cursor: pointer;
	}
	.btn-outline:disabled,
	.btn-outline[aria-disabled='true'] {
		opacity: 0.45;
		cursor: default;
	}
	.btn-quiet,
	.btn-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: var(--font-size-s);
		text-decoration: underline;
		cursor: pointer;
	}
	.btn-quiet {
		color: var(--color-fg-muted);
	}
	.btn-link {
		color: var(--color-accent);
	}

	.progress {
		margin: 0 0 var(--space-m);
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-s);
		font-size: var(--font-size-s);
	}
	/* A native progress bar, drawn as the thin accent line on the border color. */
	.progress__bar {
		appearance: none;
		display: block;
		width: 100%;
		height: 4px;
		margin: 6px 0 4px;
		border: none;
		border-radius: 2px;
		overflow: hidden;
		background: var(--color-border);
	}
	.progress__bar::-webkit-progress-bar {
		background: var(--color-border);
	}
	.progress__bar::-webkit-progress-value {
		background: var(--color-accent);
	}
	.progress__bar::-moz-progress-bar {
		background: var(--color-accent);
	}
	.progress__keep {
		color: var(--color-fg-muted);
	}

	.docs-group {
		margin: var(--space-m) 0 0;
	}
	.docs-group__head {
		margin: 0 0 var(--space-xs);
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--color-border);
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-fg-muted);
	}
	.docs-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.doc-row {
		display: flex;
		align-items: center;
		gap: var(--space-m);
		padding: 10px 0;
		border-bottom: 1px solid var(--color-border);
	}
	.doc-row__main {
		flex: 1;
		min-width: 0;
	}
	.doc-row__title {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: var(--color-fg);
		text-align: left;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--color-border);
		text-underline-offset: 3px;
	}
	.doc-row__title:hover {
		text-decoration-color: var(--color-accent);
	}
	.doc-row__meta {
		display: block;
		margin-top: 2px;
		font-size: 13px;
		color: var(--color-fg-muted);
	}
	.doc-row__saved {
		color: var(--color-success);
		font-weight: 600;
	}
	/* The danger color, not a new amber: it is the app's attention color and holds contrast in both themes. */
	.doc-row__updated,
	.doc-row__failed {
		color: var(--color-danger);
		font-weight: 600;
	}
	.doc-row__act {
		flex: none;
	}
	.doc-row__acts {
		display: flex;
		align-items: center;
		gap: var(--space-m);
	}

	.docs-foot {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}
	/* Settings' destructive CTA: danger border + text, never a filled alarm. */
	.danger-cta {
		padding: var(--space-s) var(--space-l);
		background: none;
		color: var(--color-danger);
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.docs-hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.docs-web {
		margin: var(--space-m) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.docs-web a {
		color: var(--color-accent);
	}

	/* Settings' erase dialog, the precedent for confirming a destructive action. */
	.docs-dialog {
		max-width: 28rem;
		padding: var(--space-l);
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
	}
	.docs-dialog::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.docs-dialog__heading {
		margin: 0 0 var(--space-m);
	}
	.docs-dialog__body {
		margin: 0 0 var(--space-l);
		color: var(--color-fg-muted);
	}
	.docs-dialog__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-m);
	}
	.docs-dialog__primary {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.docs-dialog__primary:hover {
		background: var(--color-accent-muted);
	}
	.docs-dialog__quiet,
	.docs-dialog__danger {
		padding: var(--space-s);
		background: none;
		border: none;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.docs-dialog__quiet {
		color: var(--color-fg-muted);
	}
	.docs-dialog__danger {
		color: var(--color-danger);
	}

	/* Phone: long titles wrap, so the action sits at the top of its row. */
	@media (max-width: 600px) {
		.doc-row {
			align-items: flex-start;
		}
	}
</style>
