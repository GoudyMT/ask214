<script lang="ts">
	import type { Source } from '$lib/ask/sources';

	// Controlled by `source`: non-null opens the modal, null closes it. The corpus IS the on-device
	// reference library; this shows all the official text held locally for one source, offline.
	let {
		source,
		highlightId = null,
		onClose
	}: { source: Source | null; highlightId?: string | null; onClose: () => void } = $props();

	let dialogEl = $state<HTMLDialogElement>();
	let citedEl = $state<HTMLElement>();

	// Sync the native dialog's open-state to the `source` prop. showModal() (not the `open` attribute)
	// is what gives the focus-trap + Esc + backdrop the modal lock calls for.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (source && !el.open) {
			el.showModal();
			// Land on the cited passage: focus it (so a keyboard / screen-reader user starts where the
			// sighted user is scrolled) and bring it into view. Instant, per the app's low-motion default.
			const cited = citedEl;
			if (cited) {
				cited.focus({ preventScroll: true });
				cited.scrollIntoView({ block: 'center' });
			}
		} else if (!source && el.open) {
			el.close();
		}
	});

	// Esc / backdrop fire the native `close` event without going through our button; tell the parent so
	// it clears `source`. Guard on `source` so our own programmatic close() (source already null) is a no-op.
	function onNativeClose() {
		if (source) onClose();
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
			<p class="reader__held">
				Showing the text saved on your device - open the official site for the complete original.
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
					<p
						class="reader__passage reader__passage--cited"
						role="region"
						aria-labelledby="reader-cited-label"
						tabindex="-1"
						bind:this={citedEl}
					>
						<span id="reader-cited-label" class="reader__cited-tag">Cited passage</span
						>{passage.text}
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
			<span class="reader__muted">Held on your device - no connection needed.</span>
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
	.reader__passage {
		margin: 0 0 var(--space-m);
		line-height: 1.65;
	}
	.reader__passage--cited {
		padding: var(--space-s) var(--space-m);
		background: rgba(74, 144, 226, 0.16);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-s);
		scroll-margin: var(--space-l) 0;
	}
	.reader__passage--cited:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.reader__cited-tag {
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
