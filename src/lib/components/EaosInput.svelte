<script lang="ts">
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
</script>

<!--
  EAOS date field (master spec 5.6). Presentational + controlled: the parent owns `value`,
  validation, and the `error` message; this renders the native date picker, label, hint, and
  an accessible inline error. Native <input type="date"> = a11y + native mobile picker +
  zero-JS + zero added bytes (spec 5.6). Copy is injected, so it is reused by wizard + Settings.
-->
<div class="eaos-field">
	<label class="eaos-field__label" for={id}>{label}</label>
	<p class="eaos-field__hint" id={hintId}>{hint}</p>
	<input
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

	.eaos-field__input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* State-color convention (spec 5.5 primitive 14): danger as border/text accent only,
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
