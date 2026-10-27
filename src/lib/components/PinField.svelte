<script lang="ts">
	import { onMount } from 'svelte';
	import type { Relockable } from '../profile/app-init';
	import { registerSecureInput } from '../profile/lifecycle';

	type Props = {
		id: string;
		label: string;
		/** The toggle's name: a form of several PIN fields names each by its field. */
		show?: string;
		value?: string;
		disabled?: boolean;
		/** A new press of Enter in the field; a held key's repeats never call it. */
		onenter?: () => void;
		/** The app's relock join: when given, a relock empties the field and hides the shown digits. */
		joinRelock?: ((r: Relockable) => () => void) | null;
	};
	let {
		id,
		label,
		show = 'Show PIN',
		value = $bindable(''),
		disabled = false,
		onenter,
		joinRelock = null
	}: Props = $props();

	// How long the digits stay on the page once the person asks to see them.
	const SHOW_PIN_MS = 5_000;

	let inputEl = $state<HTMLInputElement | null>(null);
	let shown = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const digits = $derived([...value]);
	const refuse = (e: ClipboardEvent): void => e.preventDefault();

	function hideDigits(): void {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		shown = false;
	}

	/** Empties the field and hides the shown digits. Callers call it after any result. */
	export function clear(): void {
		value = '';
		if (inputEl !== null) inputEl.value = '';
		hideDigits();
	}

	export function focus(): void {
		inputEl?.focus();
	}

	function toggleDigits(): void {
		if (shown) {
			hideDigits();
			return;
		}
		shown = true;
		timer = setTimeout(hideDigits, SHOW_PIN_MS);
	}

	// A held Enter on the field would call onenter for every repeat, and focus can arrive under a key already held:
	// only a new press counts.
	function fieldKeydown(e: KeyboardEvent): void {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (!e.repeat) onenter?.();
	}

	// A held Enter on the toggle would flip it for every repeat, and an even count leaves the digits hidden. A held Space
	// needs no guard: the button clicks when Space is released, once.
	function toggleKeydown(e: KeyboardEvent): void {
		if (e.repeat && e.key === 'Enter') e.preventDefault();
	}

	// The relock scrub reaches the field through the registry; the value is also emptied when the field goes, so
	// nothing outlives it in a node the page still holds.
	onMount(() => {
		const el = inputEl;
		if (el === null) return;
		const unregister = registerSecureInput(el);
		return () => {
			unregister();
			el.value = '';
			value = '';
			hideDigits();
		};
	});

	$effect(() => {
		if (joinRelock === null) return;
		return joinRelock({ relockSync: clear, refresh: () => Promise.resolve() });
	});
</script>

<svelte:window onpagehide={clear} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') clear();
	}}
/>

<div class="pin-field">
	<label class="pin-label" for={id}>{label}</label>
	<!-- No form around it and no name: a keyboard or a password manager has nothing to file the digits under. -->
	<input
		bind:this={inputEl}
		bind:value
		{id}
		class="pin"
		type="password"
		inputmode="numeric"
		autocomplete="one-time-code"
		spellcheck="false"
		{disabled}
		onkeydown={fieldKeydown}
		oncopy={refuse}
		oncut={refuse}
	/>
	<button
		class="pin-show"
		type="button"
		aria-pressed={shown}
		onclick={toggleDigits}
		onkeydown={toggleKeydown}>{show}</button
	>
	<!-- The digits as page text, so the field itself stays a password field: a keyboard never learns from them and
	     a screen reader does not speak the field. Not for the clipboard. -->
	{#if shown}
		<ul class="pin-digits" translate="no" oncopy={refuse} oncut={refuse}>
			{#each digits as digit, i (i)}
				<li>{digit}</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.pin-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
	}

	.pin-label {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}

	.pin {
		width: 10ch;
		padding: var(--space-s);
		font: inherit;
		letter-spacing: 0.3em;
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
	}

	.pin-show {
		align-self: flex-start;
		min-height: 44px;
		padding: var(--space-s);
		padding-inline: 0;
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.pin-digits {
		display: flex;
		gap: var(--space-s);
		align-self: flex-start;
		margin: 0;
		padding: var(--space-s);
		list-style: none;
		background: var(--color-bg);
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-m);
		font-weight: 600;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
</style>
