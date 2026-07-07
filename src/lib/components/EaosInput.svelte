<script lang="ts">
	import { registerSecureInput } from '../profile/lifecycle';

	type Props = {
		value: string;
		label: string;
		hint: string;
		onchange: (value: string) => void;
		error?: string | null;
		id?: string;
	};
	let { value, label, hint, onchange, error = null, id = 'eaos-input' }: Props = $props();

	const hintId = $derived(`${id}-hint`);
	const errorId = $derived(`${id}-error`);

	// Register the live DOM input so a relock (freezeRelock -> scrubSecureInputs) clears any
	// typed EAOS cleartext from the DOM. The $effect cleanup unregisters on
	// unmount. The parent's `value` string copy is a separate, accepted/inherent residual.
	let inputEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (inputEl) return registerSecureInput(inputEl);
	});
</script>

<!--
  EAOS date field. Presentational + controlled: the parent owns `value`,
  validation, and the `error` message; this renders the native date picker, label, hint, and
  an accessible inline error. Native <input type="date"> = a11y + native mobile picker +
  zero-JS + zero added bytes. Copy is injected, so it is reused by wizard + Settings.
-->
<div class="eaos-field">
	<label class="eaos-field__label" for={id}>{label}</label>
	<p class="eaos-field__hint" id={hintId}>{hint}</p>
	<input
		bind:this={inputEl}
		{id}
		class="eaos-field__input"
		class:eaos-field__input--error={error}
		type="date"
		{value}
		aria-describedby={error ? `${hintId} ${errorId}` : hintId}
		aria-invalid={error ? 'true' : undefined}
		oninput={(e) => onchange(e.currentTarget.value)}
	/>
	{#if error}
		<p class="eaos-field__error" id={errorId} role="alert">{error}</p>
	{/if}
</div>

<style>
	.eaos-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.eaos-field__label {
		font-weight: 600;
		color: var(--color-fg);
	}

	.eaos-field__hint {
		margin: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.eaos-field__input {
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
	}

	/* The native date-picker calendar glyph renders dark and is near-invisible on the dark
	   input background. Invert it to light (matches --color-fg) so it reads clearly and signals
	   it is clickable. Webkit pseudo-element covers our v1.0 targets (Chromium + Safari). */
	.eaos-field__input::-webkit-calendar-picker-indicator {
		filter: invert(1);
		cursor: pointer;
	}

	.eaos-field__input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* State-color convention: danger as border/text accent only,
	   never a full-bleed alarm fill. */
	.eaos-field__input--error {
		border-color: var(--color-danger);
	}

	.eaos-field__error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}
</style>
