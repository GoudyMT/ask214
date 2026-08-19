<script lang="ts">
	import { THEME_CHOICES, readChoice, setTheme, type ThemeChoice } from '$lib/theme/theme';

	let choice = $state<ThemeChoice>(readChoice());
	const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

	function pick(c: ThemeChoice) {
		choice = c;
		setTheme(c);
	}
</script>

<div class="seg" role="group" aria-label="Theme">
	{#each THEME_CHOICES as c (c)}
		<button type="button" aria-pressed={choice === c} onclick={() => pick(c)}>{LABEL[c]}</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		overflow: hidden;
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
	.seg button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
</style>
