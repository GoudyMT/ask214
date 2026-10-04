<script lang="ts">
	import { tick } from 'svelte';
	import EaosInput from './EaosInput.svelte';
	import { formatTimelineDate } from '$lib/timeline/format-date';

	type Props = {
		/** Distinct per row: the form, input, hint and error ids derive from it. */
		id: string;
		label: string;
		/** The stored ISO date, or null when not set. */
		value: string | null;
		hint: string;
		/** Validate and save the typed date; resolves to a message to show, or null once saved. */
		onSave: (draft: string) => Promise<string | null>;
		/** On a row whose date may be cleared; resolves like onSave. */
		onRemove?: () => Promise<string | null>;
	};
	let { id, label, value, hint, onSave, onRemove }: Props = $props();

	// A failed save is said, never left as a silent rejection.
	const FAILED = 'Could not update right now - please try again.';

	let editing = $state(false);
	let draft = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let toggleEl = $state<HTMLButtonElement | null>(null);

	// Closing unmounts the focused button; focus goes back to the row, so a keyboard user is not dropped.
	async function close(): Promise<void> {
		editing = false;
		error = null;
		await tick();
		toggleEl?.focus();
	}

	function toggle(): void {
		if (editing) {
			void close();
			return;
		}
		draft = value ?? '';
		error = null;
		editing = true;
	}

	async function run(action: () => Promise<string | null>): Promise<void> {
		busy = true;
		try {
			const message = await action();
			if (message === null) await close();
			else error = message;
		} catch {
			error = FAILED;
		} finally {
			busy = false;
		}
	}
</script>

<div class="settings-disclosure">
	<button
		bind:this={toggleEl}
		class="settings-disclosure__toggle"
		type="button"
		aria-expanded={editing}
		aria-controls="{id}-edit"
		onclick={toggle}
	>
		<span class="settings-chevron" class:settings-chevron--open={editing} aria-hidden="true"></span>
		<span>{label}</span>
		<span class="settings-disclosure__summary">{value ? formatTimelineDate(value) : 'Not set'}</span
		>
	</button>
	{#if editing}
		<form
			id="{id}-edit"
			class="settings-edit"
			onsubmit={(e) => {
				e.preventDefault();
				void run(() => onSave(draft));
			}}
		>
			<EaosInput
				id="{id}-input"
				value={draft}
				{error}
				onchange={(next) => {
					draft = next;
					error = null;
				}}
				{label}
				{hint}
				hideLabel
			/>
			<div class="settings-edit__actions">
				<button class="settings-save" type="submit" disabled={busy}>Save</button>
				<button class="settings-cancel" type="button" onclick={() => void close()}>Cancel</button>
				{#if onRemove && value}
					<button
						class="settings-remove"
						type="button"
						disabled={busy}
						onclick={() => void run(onRemove)}>Remove</button
					>
				{/if}
			</div>
		</form>
	{/if}
</div>

<style>
	/* Settings date disclosure: the same caret-expand idiom as the Calendar "Customize" panel, so both
	   in-place edits read as siblings. (End-state: a shared Disclosure component; today they mirror by hand.) */
	.settings-disclosure__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
		text-align: left;
	}
	.settings-disclosure__summary {
		margin-left: auto;
		color: var(--color-fg-muted);
	}
	.settings-chevron {
		width: 0;
		height: 0;
		border-left: 5px solid currentColor;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		flex: none;
	}
	.settings-chevron--open {
		transform: rotate(90deg);
	}

	.settings-edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
		margin-top: var(--space-m);
	}

	.settings-edit__actions {
		display: flex;
		align-items: center;
		gap: var(--space-m);
	}

	/* Primary CTA: filled accent + bg-colored text. */
	.settings-save {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.settings-save:hover {
		background: var(--color-accent-muted);
	}

	.settings-save:disabled {
		opacity: 0.6;
		cursor: default;
	}

	/* Quiet CTA: muted text, underline. */
	.settings-cancel {
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	/* Remove: the row's one destructive action, set apart at the end and in the danger colour, the size of Save. */
	.settings-remove {
		margin-left: auto;
		padding: var(--space-s) var(--space-l);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		color: var(--color-danger);
		font: inherit;
		cursor: pointer;
	}

	.settings-remove:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
