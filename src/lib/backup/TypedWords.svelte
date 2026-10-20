<script lang="ts">
	type Props = { text: string };
	let { text }: Props = $props();

	// Numbered as the error lines count ("Word 3 is not one of the backup words"), so a typo is found by its number.
	const words = $derived(text.trim().split(/\s+/).filter(Boolean));
	const refuse = (e: ClipboardEvent): void => e.preventDefault();
</script>

<!-- What the person typed, shown as page text so the field itself stays a password field: a keyboard never learns
     from it and spell check never reads it. Not for the clipboard, like the words themselves. -->
<ol id="backup-typed" class="typed" translate="no" oncopy={refuse} oncut={refuse}>
	{#each words as word, i (i)}
		<li>{word}</li>
	{/each}
</ol>

<style>
	.typed {
		margin: 0;
		padding: var(--space-s) var(--space-s) var(--space-s) var(--space-xl);
		background: var(--color-bg);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-m);
		font-weight: 600;
		line-height: 1.8;
		overflow-wrap: anywhere;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
</style>
