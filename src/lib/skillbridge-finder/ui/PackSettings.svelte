<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTimelineDate } from '$lib/timeline/format-date';

	type Props = {
		setupSummary: string | null;
		held: { bytes: number; pullDate: string } | null;
		/** The size of the pack a save would download; null while it is not known. */
		offerBytes: number | null;
		busy: boolean;
		onsave: () => void;
		onremove: () => void;
		/** Why the last save or removal did not happen, said under the rows. */
		error?: string | null;
	};
	let { setupSummary, held, offerBytes, busy, onsave, onremove, error = null }: Props = $props();

	const OFFLINE_HINT =
		'Keeps the listings for your region, many-state and online programs on this device, encrypted, so the finder works without a signal. They update when you are online.';

	const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);

	// Not `disabled`: a disabled button that holds focus drops it, so a press while busy is ignored instead.
	function save(): void {
		if (!busy) onsave();
	}
	function remove(): void {
		if (!busy) onremove();
	}
</script>

<section class="pack" aria-labelledby="finder-settings-heading">
	<h2 id="finder-settings-heading" class="pack__heading">SkillBridge finder</h2>

	<div class="pack__row">
		<span class="pack__label">Your setup</span>
		<span class="pack__value">{setupSummary ?? 'Not set up'}</span>
		<a class="pack__button" href="{resolve('/skillbridge')}#setup">Change</a>
	</div>

	<div class="pack__row">
		<span class="pack__label">Offline listings</span>
		{#if held}
			<span class="pack__value"
				>{`On - ${megabytes(held.bytes)} MB, from ${formatTimelineDate(held.pullDate)}`}</span
			>
			<button
				class="pack__button pack__button--danger"
				type="button"
				aria-busy={busy}
				onclick={remove}>Remove</button
			>
		{:else}
			<span class="pack__value">Off</span>
			{#if offerBytes !== null}
				<button class="pack__button" type="button" aria-busy={busy} onclick={save}
					>{`Save for offline (about ${megabytes(offerBytes)} MB)`}</button
				>
			{/if}
			<p class="pack__hint">{OFFLINE_HINT}</p>
		{/if}
		{#if error}<p class="pack__error" role="alert">{error}</p>{/if}
	</div>
</section>

<style>
	.pack {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}

	.pack__heading {
		margin: 0 0 var(--space-m);
	}

	.pack__row {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-xs);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}

	.pack__row + .pack__row {
		margin-top: var(--space-m);
	}

	.pack__label {
		font-weight: 600;
	}

	.pack__value {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* The outline button the Settings rows use, on a link where it navigates. */
	.pack__button {
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		min-height: 44px;
		margin-top: var(--space-s);
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-s);
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.pack__button--danger {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	/* A busy press does nothing, so it must not look pressable or fade the label below its contrast minimum. */
	.pack__button[aria-busy='true'] {
		cursor: default;
	}

	.pack__error {
		margin: var(--space-s) 0 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.pack__hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
</style>
