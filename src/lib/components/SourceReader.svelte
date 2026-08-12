<script lang="ts">
	import type { Source } from '$lib/ask/sources';

	// Controlled by `source`: non-null opens the modal, null closes it. The corpus IS the on-device
	// reference library; this shows all the official text held locally for one source, offline.
	let { source, onClose }: { source: Source | null; onClose: () => void } = $props();

	let dialogEl = $state<HTMLDialogElement>();

	// Sync the native dialog's open-state to the `source` prop. showModal() (not the `open` attribute)
	// is what gives the focus-trap + Esc + backdrop the modal lock calls for.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (source && !el.open) el.showModal();
		else if (!source && el.open) el.close();
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
			<!-- key by the stable chunk id (unique within a corpus version), not the index -->
			{#each source.passages as passage (passage.id)}
				<p class="reader__passage">{passage.text}</p>
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
