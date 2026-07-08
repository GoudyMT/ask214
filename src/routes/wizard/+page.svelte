<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EaosInput from '$lib/components/EaosInput.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { OccConflictError } from '$lib/profile/store.svelte';
	import {
		validateEaosAtInput,
		encodeEaos,
		EaosFormatError,
		type EaosCause
	} from '$lib/profile/eaos';

	const app = getProfileApp();

	let value = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);

	// Device clock display feeds the implicit clock check (read-only, not PII).
	const todayDisplay = new Date().toLocaleDateString();

	// PII-free, user-facing copy for each validation cause. Native <input type="date"> makes
	// month/day/format-from-malformed unreachable in practice; empty submit -> 'format'.
	const ERROR_COPY: Record<EaosCause, string> = {
		format: 'Please enter your separation date.',
		'year-range': 'Enter a date within about 15 years from today.',
		month: 'Please enter a valid date.',
		day: 'Please enter a valid date.'
	};

	function onInput(next: string): void {
		value = next;
		error = null;
	}

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const store = app.store;
		if (!store) return;

		let bytes: Uint8Array;
		try {
			bytes = encodeEaos(validateEaosAtInput(value));
		} catch (err) {
			if (err instanceof EaosFormatError) {
				error = ERROR_COPY[err.cause];
				return;
			}
			throw err;
		}

		saving = true;
		try {
			await store.save({ eaos: bytes, setupIntent: 'completed' });
			await goto(resolve('/'));
		} catch (err) {
			if (err instanceof OccConflictError) {
				// Another tab set up the profile first. Reload the authoritative state and ask
				// the user to review + retry (OCC: reload, don't clobber).
				await store.load();
				error = 'This was changed in another tab. We reloaded it - please review and save again.';
				return;
			}
			throw err;
		} finally {
			saving = false;
		}
	}

	async function skip(): Promise<void> {
		await goto(resolve('/'));
	}
</script>

<svelte:head>
	<title>Set up your profile</title>
</svelte:head>

<section class="wizard" aria-labelledby="wizard-heading">
	<h1 id="wizard-heading">Set up your profile</h1>
	<p class="wizard__lead">
		Add your separation date and we'll build a transition timeline around it. Everything stays
		encrypted on this device - it never leaves.
	</p>

	{#if app.status === 'ready'}
		<form class="wizard__form" onsubmit={(e) => void save(e)}>
			<EaosInput
				{value}
				{error}
				onchange={onInput}
				label="Separation date (EAOS)"
				hint="Your End of Active Obligated Service - the date your current obligation ends."
			/>
			<p class="wizard__today">Today on this device: {todayDisplay}</p>

			<div class="wizard__actions">
				<button class="wizard__save" type="submit" disabled={saving}>Save and continue</button>
				<button class="wizard__skip" type="button" onclick={() => void skip()}>Skip for now</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.wizard {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}

	.wizard h1 {
		margin: 0;
	}

	.wizard__lead {
		margin: 0;
		color: var(--color-fg-muted);
	}

	.wizard__form {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
	}

	.wizard__today {
		margin: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.wizard__actions {
		display: flex;
		align-items: center;
		gap: var(--space-m);
	}

	/* Primary CTA: filled accent + bg-colored text. */
	.wizard__save {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.wizard__save:hover {
		background: var(--color-accent-muted);
	}

	.wizard__save:disabled {
		opacity: 0.6;
		cursor: default;
	}

	/* Quiet CTA: muted text, underline. De-emphasized but clearly visible. */
	.wizard__skip {
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
