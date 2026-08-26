<script lang="ts">
	import type { Source } from '$lib/ask/sources';

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
		onClose
	}: {
		source: Source | null;
		highlightId?: string | null;
		loading?: boolean;
		error?: boolean;
		// True when the answer came from the online path. The reader shows the local corpus text either
		// way, but the on-device / no-connection reassurance only applies to on-device answers.
		online?: boolean;
		onClose: () => void;
	} = $props();

	let dialogEl = $state<HTMLDialogElement>();
	let citedEl = $state<HTMLElement>();
	let errorEl = $state<HTMLElement>();

	const isOpen = $derived(source !== null || loading || error);

	// Sync the native dialog's open-state. showModal() (not the `open` attribute) is what gives the
	// focus-trap + Esc + backdrop the modal lock calls for.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (isOpen && !el.open) el.showModal();
		else if (!isOpen && el.open) el.close();
	});

	// Once content is present, land on the cited passage (focus + scroll) - runs on the null->source
	// transition too, so focus lands when a source resolves after the loading state. Instant, per the
	// app's low-motion default; block:'start' lands at the TOP of the (often taller-than-viewport) block.
	$effect(() => {
		if (source && dialogEl?.open && citedEl) {
			citedEl.focus({ preventScroll: true });
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
	{#if source}
		<div class="reader__head">
			<div>
				<p class="reader__src">Source</p>
				<h2 id="ask-reader-title" class="reader__title">{source.title}</h2>
			</div>
			<button class="reader__close" type="button" aria-label="Close" onclick={onClose}
				>&times;</button
			>
		</div>
		<div class="reader__body">
			<p class="reader__held" class:reader__held--neutral={online}>
				{#if online}
					Showing the official source text - open the official site for the complete original.
				{:else}
					Showing the text saved on your device - open the official site for the complete original.
				{/if}
			</p>
			<!-- index key: this list is replace-all re-rendered per source and never reordered, so the index
			     is stable and collision-proof; the highlight matches on passage.id === highlightId, not the key -->
			{#each source.passages as passage, i (i)}
				{#if passage.section && passage.section !== source.passages[i - 1]?.section}
					<h3 class="reader__section">{passage.section}</h3>
				{/if}
				{#if passage.page !== undefined && passage.page !== source.passages[i - 1]?.page}
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
		</div>
		<div class="reader__foot">
			<!-- external public-source citation (https), not internal SvelteKit nav; resolve() does not apply. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="reader__link" href={source.url} target="_blank" rel="noopener noreferrer"
				>View on the official site</a
			>
			{#if !online}
				<span class="reader__muted">Held on your device - no connection needed.</span>
			{/if}
		</div>
	{:else if loading || error}
		<div class="reader__head">
			<div>
				<p class="reader__src">Source</p>
				<h2 id="ask-reader-title" class="reader__title">
					{loading ? 'Loading the source' : 'Source unavailable'}
				</h2>
			</div>
			<button class="reader__close" type="button" aria-label="Close" onclick={onClose}
				>&times;</button
			>
		</div>
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
		padding: var(--space-l);
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
	@media (max-width: 600px) {
		.reader {
			width: 100vw;
			max-width: 100vw;
			height: 100vh;
			max-height: 100vh;
			border: none;
			border-radius: 0;
		}
	}
</style>
