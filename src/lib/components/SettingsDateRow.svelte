<script lang="ts">
	import { tick } from 'svelte';
	import EaosInput from './EaosInput.svelte';
	import { formatTimelineDate } from '#lib/timeline/format-date.js';

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
	// The action that is running. Its own button stays on (a disabled button that holds focus drops it) and ignores a
	// press; the other action is off until it settles.
	let running = $state<'save' | 'remove' | null>(null);
	const busy = $derived(running !== null);
	let toggleEl = $state<HTMLButtonElement | null>(null);

	// Closing unmounts the focused button; focus goes back to the row, so a keyboard user is not dropped - unless
	// they have already moved on to another control.
	async function close(): Promise<void> {
		editing = false;
		error = null;
		await tick();
		if (document.activeElement === document.body) toggleEl?.focus();
	}

	function toggle(): void {
		// The toggle closes the form as Cancel does, so it waits for a save to settle too: a failure needs the form to show.
		if (busy) return;
		if (editing) {
			void close();
			return;
		}
		draft = value ?? '';
		error = null;
		editing = true;
	}

	async function run(
		which: 'save' | 'remove',
		action: () => Promise<string | null>
	): Promise<void> {
		if (busy) return;
		running = which;
		// Cleared first, so the same failure on a retry is put back on the page and read out again.
		error = null;
		let message: string | null;
		try {
			message = await action();
		} catch {
			message = FAILED;
		}
		if (message === null) await close();
		else error = message;
		running = null;
	}
</script>

<div class="settings-disclosure">
	<!-- A save or remove that lands hands focus here mid-press, so a held Enter's repeats would open the form again:
	     only a new press toggles. -->
	<button
		bind:this={toggleEl}
		class="settings-disclosure__toggle"
		type="button"
		aria-expanded={editing}
		aria-controls="{id}-edit"
		onclick={toggle}
		onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
	>
		<span class="settings-chevron" class:settings-chevron--open={editing} aria-hidden="true"></span>
		<span>{label}</span>
		<span class="settings-disclosure__summary">{value ? formatTimelineDate(value) : 'Not set'}</span
		>
	</button>
	{#if editing}
		<!-- A held Enter repeats, in the field or on Save, and each repeat would submit again once the last save settled:
		     only a new press submits. The form only filters its controls' keys; it is not a control itself, so the
		     compiler's rule against key listeners on a non-interactive element does not fit. -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form
			id="{id}-edit"
			class="settings-edit"
			onsubmit={(e) => {
				e.preventDefault();
				void run('save', () => onSave(draft));
			}}
			onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
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
				<button
					class="settings-save"
					type="submit"
					disabled={running === 'remove'}
					aria-busy={running === 'save'}>Save</button
				>
				<button class="settings-cancel" type="button" disabled={busy} onclick={() => void close()}
					>Cancel</button
				>
				{#if onRemove && value}
					<button
						class="settings-remove"
						type="button"
						disabled={running === 'save'}
						aria-busy={running === 'remove'}
						onclick={() => void run('remove', onRemove)}>Remove</button
					>
				{/if}
			</div>
		</form>
	{/if}
</div>

<style>
	/* Settings date disclosure: the same caret-expand idiom as the Calendar "Customize" panel, so both
	   in-place edits read as siblings. (End-state: a shared Disclosure component; today they mirror by hand.) */
	/* min-height: the 44px touch target, which also keeps the stacked rows apart. */
	.settings-disclosure__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
		text-align: left;
	}
	/* A date reads as one piece: the label wraps before the date does. */
	.settings-disclosure__summary {
		margin-left: auto;
		color: var(--color-fg-muted);
		white-space: nowrap;
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

	/* flex-wrap: on a phone a button that will not fit drops to the next line instead of past the card. */
	.settings-edit__actions {
		display: flex;
		flex-wrap: wrap;
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
	/* No dim while busy: a dim would fade the focus ring or the label below their contrast minimums. The label does not
	   change either, so only aria-busy marks the work - accepted, as the work is local and usually over before it
	   could be seen. The hover fill stays off too, as a press does nothing. */
	.settings-save[aria-busy='true'] {
		background: var(--color-accent);
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

	.settings-cancel:disabled {
		opacity: 0.6;
		cursor: default;
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
	.settings-remove[aria-busy='true'] {
		cursor: default;
	}
</style>
