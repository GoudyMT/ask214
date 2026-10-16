<script lang="ts">
	import { CARD_LABELS, PHRASE_NOTE } from './copy';

	type Props = {
		words: readonly string[];
		onhide: () => void;
	};
	let { words, onhide }: Props = $props();

	let noteEl = $state<HTMLElement | null>(null);

	/** Where focus goes when the words appear: the line that says what to do with them, not a button. */
	export function focus(): void {
		noteEl?.focus();
	}

	// Nothing here is for the clipboard: the words are written down or typed back, and a copy would leave them in
	// clipboard history.
	const refuse = (e: ClipboardEvent): void => e.preventDefault();
</script>

<!-- A held Enter on Show hands focus to the note during the press; the note is not a button, so a repeat does nothing.
     Hide takes itself off the page at once, so no repeat reaches it; the repeats land on Show, which ignores them. -->
<div
	class="phrase"
	role="group"
	aria-labelledby="backup-phrase-note"
	oncopy={refuse}
	oncut={refuse}
>
	<p id="backup-phrase-note" class="phrase__note" tabindex="-1" bind:this={noteEl}>{PHRASE_NOTE}</p>
	<ol class="phrase__words">
		{#each words as word, i (i)}
			<li>{word}</li>
		{/each}
	</ol>
	<button class="phrase__hide" type="button" onclick={onhide}>
		{CARD_LABELS.hide}
	</button>
</div>

<style>
	/* The words cannot be selected or long-pressed into a Copy menu; a screenshot is the person's own act. */
	.phrase {
		margin-top: var(--space-m);
		padding: var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
	.phrase__note {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.phrase__note:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.phrase__words {
		margin: 0 0 var(--space-m);
		padding-left: var(--space-xl);
		font-size: var(--font-size-l);
		font-weight: 600;
		line-height: 1.8;
	}
	.phrase__hide {
		padding: var(--space-s) 0;
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
