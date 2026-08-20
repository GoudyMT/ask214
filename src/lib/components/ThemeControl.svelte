<script lang="ts">
	import { onMount } from 'svelte';
	import {
		THEME_CHOICES,
		THEME_KEY,
		readChoice,
		setTheme,
		type ThemeChoice
	} from '$lib/theme/theme';

	let choice = $state<ThemeChoice>(readChoice());
	const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

	function pick(c: ThemeChoice) {
		choice = c;
		setTheme(c);
	}

	// A theme change in another tab (or an erase) fires a `storage` event; refresh the active segment
	// so the control never shows a stale choice. The layout re-applies the palette app-wide.
	onMount(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key === THEME_KEY || e.key === null) choice = readChoice();
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});
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
	/* On the selected (accent-filled) segment an accent ring would be accent-on-accent and invisible;
	   use the bg color so the focus indicator stays visible (WCAG 2.4.7 / 1.4.11). */
	.seg button[aria-pressed='true']:focus-visible {
		outline-color: var(--color-bg);
	}
</style>
