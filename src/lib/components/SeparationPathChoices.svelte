<script lang="ts">
	import type { SeparationPath } from '#lib/profile/separation-path.js';

	let {
		value,
		onchange,
		name,
		disabled = false,
		label = 'How are you leaving? (optional)',
		hint = 'This adds the steps for your path. It stays on this device.'
	}: {
		value: SeparationPath | undefined;
		/** "Not sure yet" sends undefined: it stores nothing, the same as no answer. */
		onchange: (next: SeparationPath | undefined) => void;
		name: string;
		disabled?: boolean;
		label?: string;
		hint?: string;
	} = $props();

	const CHOICES: { value: SeparationPath | undefined; label: string }[] = [
		{ value: 'ets', label: 'Finishing my service' },
		{ value: 'retirement', label: 'Retiring' },
		{ value: 'medical', label: 'A medical board' },
		{ value: 'reserve-component', label: 'Leaving the Guard or Reserve' },
		{ value: undefined, label: 'Not sure yet' }
	];

	// "Not sure yet" shows as picked only once it has been pressed, so the group starts with nothing picked.
	let unsurePicked = $state(false);
	const labelId = $derived(`${name}-label`);
	const hintId = $derived(`${name}-hint`);
</script>

<div class="path-choices" role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId}>
	<p class="path-choices__label" id={labelId}>{label}</p>
	<p class="path-choices__hint" id={hintId}>{hint}</p>
	<div class="path-choices__options">
		{#each CHOICES as c (c.label)}
			<label class="path-choices__choice">
				<input
					type="radio"
					{name}
					{disabled}
					checked={c.value === undefined ? value === undefined && unsurePicked : value === c.value}
					onchange={() => {
						unsurePicked = c.value === undefined;
						onchange(c.value);
					}}
				/>
				<span>{c.label}</span>
			</label>
		{/each}
	</div>
</div>

<style>
	.path-choices {
		margin: var(--space-l) 0 0;
	}
	.path-choices__label {
		margin: 0;
		font-weight: 600;
		color: var(--color-fg);
	}
	.path-choices__hint {
		margin: var(--space-xs) 0 var(--space-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.path-choices__options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
	}
	/* Each choice is a pill with a 44px target that may wrap to a second line at large text sizes rather than
	   overflow the card; the radio stays focusable but is drawn as the pill. */
	.path-choices__choice {
		position: relative;
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		max-width: 100%;
		min-height: 44px;
		padding: 0 var(--space-m);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.path-choices__choice input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.path-choices__choice:hover {
		border-color: var(--color-accent);
	}
	.path-choices__choice:has(input:checked) {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
		color: var(--color-fg);
	}
	@media (forced-colors: active) {
		.path-choices__choice:has(input:checked) {
			border: 3px solid Highlight;
		}
	}
	.path-choices__choice:has(input:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
