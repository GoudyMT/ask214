<script lang="ts">
	import { tick } from 'svelte';
	import { RESOURCES, COMMAND_INSTRUCTIONS } from '$lib/resources';
	import type { PlanAnswer } from '$lib/timeline/skillbridge-plan';
	import {
		QUESTION_FIRST,
		QUESTION_AGAIN,
		ANSWER_LABEL,
		SETTINGS_HINT,
		ABOUT_LINK,
		ANSWERED,
		askAgainLine
	} from '$lib/timeline/skillbridge-copy';

	type Props = {
		wording: 'first' | 'again';
		/** The day a Not sure brings the card back, or null when a Not sure now shows the steps. */
		notSureReturns: string | null;
		/** Saves the answer; rejects when the save fails. */
		onAnswer: (answer: PlanAnswer) => Promise<void>;
	};
	let { wording, notSureReturns, onAnswer }: Props = $props();

	const FAILED = 'Could not update right now - please try again.';
	const ANSWERS: readonly PlanAnswer[] = ['yes', 'not-sure', 'no'];
	const about = RESOURCES.find((r) => r.id === 'skillbridge');

	const words = $derived(wording === 'first' ? QUESTION_FIRST : QUESTION_AGAIN);
	// The question that was tapped stays on screen until the status line replaces it, even when the page changes the
	// wording as soon as the store takes the answer.
	let tapped = $state<typeof QUESTION_FIRST | null>(null);
	const shown = $derived(tapped ?? words);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let answered = $state<string | null>(null);
	let heldHeight = $state<number | null>(null);
	let cardEl = $state<HTMLElement | null>(null);
	let lineEl = $state<HTMLElement | null>(null);

	async function answer(choice: PlanAnswer): Promise<void> {
		// Worked out before the save, while the props still describe the question that was answered.
		const line =
			choice === 'no'
				? ANSWERED.no
				: choice === 'not-sure' && notSureReturns
					? askAgainLine(notSureReturns)
					: ANSWERED.yes;
		tapped = words;
		busy = true;
		error = null;
		try {
			await onAnswer(choice);
			// The frame keeps the height it has when the line replaces the question, so the card below does not move
			// under the finger that just tapped. Measured here, not at the tap: a retry's tap still showed the error.
			heldHeight = cardEl?.offsetHeight ?? null;
			answered = line;
			await tick();
			lineEl?.focus();
		} catch {
			tapped = null;
			error = FAILED;
		} finally {
			busy = false;
		}
	}
</script>

<section
	bind:this={cardEl}
	class="sb-card"
	aria-labelledby={answered ? undefined : 'sb-card-heading'}
	style:min-height={heldHeight ? `${heldHeight}px` : undefined}
>
	{#if answered}
		<p bind:this={lineEl} class="sb-card__done" role="status" tabindex="-1">{answered}</p>
	{:else}
		<h2 id="sb-card-heading" class="sb-card__heading">{shown.heading}</h2>
		<p class="sb-card__copy">{shown.line}</p>
		<div class="sb-card__answers" role="group" aria-labelledby="sb-card-heading">
			{#each ANSWERS as choice (choice)}
				<button type="button" disabled={busy} onclick={() => void answer(choice)}
					>{ANSWER_LABEL[choice]}</button
				>
			{/each}
		</div>
		{#if error}<p class="sb-card__error" role="alert">{error}</p>{/if}
		<p class="sb-card__hint">
			{SETTINGS_HINT}
			{#if about}<a href={about.url} target="_blank" rel="noopener noreferrer external"
					>{ABOUT_LINK}<span class="visually-hidden"> (opens in a new tab)</span></a
				>{/if}
		</p>
		<p class="sb-card__hint">{COMMAND_INSTRUCTIONS}</p>
	{/if}
</section>

<style>
	/* The calendar card's offer look: an accent edge, not a warning. Static, per the brand register. */
	.sb-card {
		display: flex;
		flex-direction: column;
		justify-content: center;
		margin-bottom: var(--space-l);
		padding: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-l);
	}
	.sb-card__heading {
		margin: 0 0 var(--space-xs);
		font-size: var(--font-size-m, 1rem);
	}
	.sb-card__copy {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	/* The task card's pills: 44px targets that wrap on a narrow phone, all three equal so none is pushed. */
	.sb-card__answers {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
	}
	.sb-card__answers button {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		white-space: nowrap;
		cursor: pointer;
	}
	.sb-card__answers button:hover {
		border-color: var(--color-accent);
	}
	.sb-card__answers button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.sb-card__hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.sb-card__hint a {
		color: var(--color-accent);
	}
	.sb-card__error {
		margin: var(--space-s) 0 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}
	.sb-card__done {
		margin: 0;
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
