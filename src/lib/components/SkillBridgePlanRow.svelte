<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { PlanAnswer, PlanRead } from '$lib/timeline/skillbridge-plan';
	import {
		ANSWER_LABEL,
		ROW_LABEL,
		ROW_SUMMARY,
		ROW_UNAVAILABLE,
		ROW_UNAVAILABLE_SUMMARY,
		ROW_HINT_LATE,
		rowHintEarly
	} from '$lib/timeline/skillbridge-copy';

	type Props = {
		/** The answer, or null while the timeline store cannot be read (no value is shown and nothing is offered). */
		plan: PlanRead | null;
		/** Save the picked answer; resolves to a message to show, or null once saved. */
		onSave: (answer: PlanAnswer) => Promise<string | null>;
	};
	let { plan, onSave }: Props = $props();

	const FAILED = 'Could not update right now - please try again.';
	const ANSWERS: readonly PlanAnswer[] = ['yes', 'not-sure', 'no'];

	let editing = $state(false);
	let choice = $state<PlanAnswer | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let toggleEl = $state<HTMLButtonElement | null>(null);
	let unavailableEl = $state<HTMLElement | null>(null);
	let saveEl = $state<HTMLButtonElement | null>(null);
	// The form shows only while the answer can be read, so the row never stays open on a disabled toggle.
	const open = $derived(editing && plan !== null);

	// When the answer turns unreadable the row closes for good: the form's controls are gone and the toggle is disabled,
	// so neither can hold focus, and coming back must not reopen a stale choice. A row that was never open leaves focus
	// alone. A disabled button cannot take focus, so the unavailable line is the target.
	$effect(() => {
		if (plan !== null) return;
		const wasOpen = untrack(() => editing);
		editing = false;
		error = null;
		if (!wasOpen) return;
		const active = document.activeElement;
		if (active === null || active === document.body || active === toggleEl) unavailableEl?.focus();
	});

	// A saved Not sure says what it does itself; any other saved answer is described by what a choice made today would do.
	const hint = $derived.by(() => {
		if (plan?.answer === 'not-sure') {
			if (plan.returnsOn) return rowHintEarly(plan.returnsOn);
			if (plan.stepsShow) return ROW_HINT_LATE;
		}
		return plan?.notSureReturns ? rowHintEarly(plan.notSureReturns) : ROW_HINT_LATE;
	});

	// Closing unmounts the focused control; focus goes back to the row, so a keyboard user is not dropped.
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
		choice = plan && plan.answer !== 'none' ? plan.answer : null;
		error = null;
		editing = true;
	}

	async function save(): Promise<void> {
		if (choice === null) return;
		busy = true;
		let failed = false;
		try {
			const message = await onSave(choice);
			if (message === null) await close();
			else {
				error = message;
				failed = true;
			}
		} catch {
			error = FAILED;
			failed = true;
		} finally {
			busy = false;
		}
		if (!failed) return;
		// Save was disabled while the save ran, which dropped focus to the page; put it back so the person can try
		// again, unless they have already moved on.
		await tick();
		const active = document.activeElement;
		if (active === null || active === document.body) saveEl?.focus();
	}
</script>

<div class="settings-disclosure">
	<button
		bind:this={toggleEl}
		class="settings-disclosure__toggle"
		type="button"
		aria-expanded={open}
		aria-controls="skillbridge-plan-edit"
		disabled={plan === null}
		onclick={toggle}
	>
		<span class="settings-chevron" class:settings-chevron--open={open} aria-hidden="true"></span>
		<span>{ROW_LABEL}</span>
		<span class="settings-disclosure__summary"
			>{plan ? ROW_SUMMARY[plan.answer] : ROW_UNAVAILABLE_SUMMARY}</span
		>
	</button>
	{#if plan === null}
		<!-- tabindex -1: a target for the focus move above, never a stop on the Tab order. -->
		<p bind:this={unavailableEl} class="sb-row__hint" tabindex="-1">{ROW_UNAVAILABLE}</p>
	{:else if open}
		<form
			id="skillbridge-plan-edit"
			class="settings-edit"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<fieldset class="sb-row__choices">
				<legend class="visually-hidden">{ROW_LABEL}</legend>
				{#each ANSWERS as a (a)}
					<label class="sb-row__choice">
						<input
							type="radio"
							name="skillbridge-plan"
							value={a}
							checked={choice === a}
							onchange={() => {
								choice = a;
								error = null;
							}}
						/>
						<span>{ANSWER_LABEL[a]}</span>
					</label>
				{/each}
			</fieldset>
			<p class="sb-row__hint">{hint}</p>
			{#if error}<p class="sb-row__error" role="alert">{error}</p>{/if}
			<div class="settings-edit__actions">
				<button
					bind:this={saveEl}
					class="settings-save"
					type="submit"
					disabled={busy || choice === null}>Save</button
				>
				<button class="settings-cancel" type="button" onclick={() => void close()}>Cancel</button>
			</div>
		</form>
	{/if}
</div>

<style>
	/* SettingsDateRow's disclosure, hand-copied (the app has no shared disclosure component yet), so the rows read
	   as siblings. */
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
	.settings-disclosure__toggle:disabled {
		opacity: 0.6;
		cursor: default;
	}
	/* A value reads as one piece: the label wraps before the value does. */
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

	.sb-row__choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		margin: 0;
		padding: 0;
		border: none;
	}
	/* Each choice is a pill with a 44px target; the radio itself stays focusable but is drawn as the pill. */
	.sb-row__choice {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-m);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font-size: var(--font-size-s);
		white-space: nowrap;
		cursor: pointer;
	}
	/* Covers the whole pill, invisible; not clipped to a pixel, which would let the label take the click. */
	.sb-row__choice input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.sb-row__choice:hover {
		border-color: var(--color-accent);
	}
	.sb-row__choice:has(input:checked) {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 15%, transparent);
		color: var(--color-fg);
	}
	/* Forced colors replace the fill and the colours that mark the chosen pill, and the radio is invisible, so the pill
	   is marked by a heavier border in the system highlight colour. */
	@media (forced-colors: active) {
		.sb-row__choice:has(input:checked) {
			border-width: 3px;
			border-color: Highlight;
		}
	}
	.sb-row__choice:has(input:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.sb-row__hint {
		margin: var(--space-xs) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.sb-row__error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
