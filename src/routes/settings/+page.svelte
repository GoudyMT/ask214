<script lang="ts">
	import EaosInput from '$lib/components/EaosInput.svelte';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { eraseEverything } from '$lib/profile/erase';
	import { OccConflictError } from '$lib/profile/store.svelte';
	import {
		validateEaosAtInput,
		encodeEaos,
		EaosFormatError,
		type EaosCause
	} from '$lib/profile/eaos';
	import CalendarPanel from '$lib/components/CalendarPanel.svelte';
	import { downloadTextFile } from '$lib/calendar/download';
	import { generateTimeline, TASK_DEFS, type TimelineState } from '$lib/timeline';

	const app = getProfileApp();

	let editing = $state(false);
	let draft = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);
	let unlocking = $state(false);
	let wipeDialog = $state<HTMLDialogElement | null>(null);
	let clockFixEl = $state<HTMLButtonElement | null>(null);
	let clockError = $state<string | null>(null);

	// PII-free, user-facing copy per validation cause (matches the wizard).
	const ERROR_COPY: Record<EaosCause, string> = {
		format: 'Please enter your separation date.',
		'year-range': 'Enter a date within about 15 years from today.',
		month: 'Please enter a valid date.',
		day: 'Please enter a valid date.'
	};

	// Current stored EAOS (string form) via the derived persona, or null when unset.
	const currentEaos = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.eaos : null;
	});

	// Until the timeline-state store provisions, fall back to empty state so the calendar panel
	// still lists date-derived pending tasks; stored done/skip/snooze layer in once it loads.
	const EMPTY_STATE: TimelineState = { schemaVersion: 1, tasks: {} };

	// The flat pending-task list the calendar panel projects to events - the timeline route's
	// generation, flattened across phases. Empty until a persona with an EAOS exists.
	const calendarItems = $derived.by(() => {
		const persona = app.store?.persona;
		if (!persona || persona.completeness === 'none') return [];
		const state = app.timeline?.state ?? EMPTY_STATE;
		return generateTimeline(persona, [...TASK_DEFS], state, new Date()).phases.flatMap(
			(p) => p.items
		);
	});

	function startEdit(): void {
		draft = currentEaos ?? '';
		error = null;
		editing = true;
	}

	function cancel(): void {
		editing = false;
		error = null;
	}

	function onInput(next: string): void {
		draft = next;
		error = null;
	}

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const store = app.store;
		if (!store) return;

		let bytes: Uint8Array;
		try {
			bytes = encodeEaos(validateEaosAtInput(draft));
		} catch (err) {
			if (err instanceof EaosFormatError) {
				error = ERROR_COPY[err.cause];
				return;
			}
			throw err;
		}

		saving = true;
		try {
			await store.save({ eaos: bytes });
			editing = false;
		} catch (err) {
			if (err instanceof OccConflictError) {
				// Reload authoritative state; stay in edit mode so the message + input stay visible
				// (OCC: reload, don't clobber).
				await store.load();
				error = 'This was changed in another tab. We reloaded it - please review and save again.';
				return;
			}
			throw err;
		} finally {
			saving = false;
		}
	}

	async function lock(): Promise<void> {
		await app.store?.lock();
	}

	async function unlock(): Promise<void> {
		const store = app.store;
		if (!store) return;
		unlocking = true;
		try {
			await store.load();
			// The secondary stores relock alongside the profile on idle/pagehide but are not part of
			// the profile's load; without this they stay unloaded behind an unlocked UI (see the
			// timeline route for the full reasoning). allSettled so a secondary failure leaves that
			// store not-ready rather than blocking the unlock.
			await Promise.allSettled([app.timeline?.load(), app.calendar?.load()]);
		} finally {
			unlocking = false;
		}
	}

	async function clearClock(): Promise<void> {
		clockError = null;
		try {
			await app.store?.clearClockBackward();
		} catch {
			// Clear failed (e.g. another tab edited concurrently); the store rolled the in-memory
			// mark back, so the banner/notice correctly stay up. Tell the user they can retry.
			clockError = 'Could not update right now - please try again.';
		}
	}

	async function confirmErase(): Promise<void> {
		wipeDialog?.close();
		await eraseEverything({
			relock: () => app.store?.relockSync(),
			wipeAll: app.wipeAll,
			// Defensive: the app stores no PII outside IndexedDB, but the erase clears localStorage +
			// Cache Storage for completeness.
			clearStorage: () => window.localStorage.clear(),
			clearCaches: async () => {
				if (!('caches' in window)) return;
				const keys = await window.caches.keys();
				await Promise.all(keys.map((key) => window.caches.delete(key)));
			},
			// Reload -> app-init bootstraps a fresh keystore -> clean first-run state.
			reload: () => window.location.reload()
		});
	}

	// Draw attention to the clock reset while the clock is backward: move focus to it + scroll
	// it into view (a static --color-danger highlight in CSS does the visual emphasis). No
	// animation (no-motion brand register). Fires once per backward episode so it does not
	// repeatedly steal focus.
	let clockFocused = false;
	$effect(() => {
		const backward = app.store?.clockBackward ?? false;
		if (backward && clockFixEl && !clockFocused) {
			clockFocused = true;
			clockFixEl.scrollIntoView({ block: 'center' });
			clockFixEl.focus();
		} else if (!backward) {
			clockFocused = false;
		}
	});
</script>

<svelte:head>
	<title>Settings</title>
</svelte:head>

<h1>Settings</h1>

{#if app.status === 'ready'}
	{#if app.store?.locked}
		<LockedPanel onunlock={() => void unlock()} busy={unlocking} />
	{:else}
		<section class="settings-section" aria-labelledby="timeline-heading">
			<h2 id="timeline-heading" class="settings-section__heading">Transition timeline</h2>

			{#if editing}
				<form class="settings-edit" onsubmit={(e) => void save(e)}>
					<EaosInput
						value={draft}
						{error}
						onchange={onInput}
						label="Separation date (EAOS)"
						hint="Your End of Active Obligated Service - the date your current obligation ends."
					/>
					<div class="settings-edit__actions">
						<button class="settings-save" type="submit" disabled={saving}>Save</button>
						<button class="settings-cancel" type="button" onclick={cancel}>Cancel</button>
					</div>
				</form>
			{:else}
				<div class="settings-row">
					<div class="settings-row__field">
						<span class="settings-row__label">Separation date (EAOS)</span>
						<span class="settings-row__value">{currentEaos ?? 'Not set'}</span>
					</div>
					<button class="settings-row__change" type="button" onclick={startEdit}>
						{currentEaos ? 'Change' : 'Add'}
					</button>
				</div>
			{/if}

			{#if app.store?.clockBackward}
				<div class="clock-notice">
					<p id="clock-notice-msg" class="clock-notice__msg">
						Your device clock appears to have moved backward - your timeline dates may be off.
					</p>
					<button
						bind:this={clockFixEl}
						class="clock-notice__fix"
						type="button"
						aria-describedby="clock-notice-msg"
						onclick={() => void clearClock()}
					>
						I fixed my clock
					</button>
					{#if clockError}
						<p class="clock-notice__error" role="alert">{clockError}</p>
					{/if}
				</div>
			{/if}
		</section>

		<section class="settings-section" aria-labelledby="privacy-heading">
			<h2 id="privacy-heading" class="settings-section__heading">Privacy and security</h2>
			<button class="settings-lock" type="button" onclick={() => void lock()}>Lock</button>
			<p class="settings-hint">
				Clears your profile from this screen. Use Unlock to view it again.
			</p>

			<div class="danger-zone">
				<button class="danger-cta" type="button" onclick={() => wipeDialog?.showModal()}>
					Erase all data on this device
				</button>
			</div>
		</section>

		<CalendarPanel
			items={calendarItems}
			exclusions={app.calendar?.exclusions ?? { taskIds: [], categories: [] }}
			ready={app.calendar?.ready ?? false}
			onSetExclusions={(next) =>
				void app.calendar?.setExclusions(next).catch(() => app.calendar?.load())}
			onDownload={(ics) => downloadTextFile('transition-deadlines.ics', 'text/calendar', ics)}
		/>

		<dialog
			bind:this={wipeDialog}
			class="wipe-dialog"
			aria-labelledby="wipe-dialog-heading"
			aria-describedby="wipe-dialog-body"
		>
			<h2 id="wipe-dialog-heading" class="wipe-dialog__heading">Erase all data on this device?</h2>
			<p id="wipe-dialog-body" class="wipe-dialog__body">
				This permanently erases everything stored on this device - your separation date and any
				profile details. It can't be undone.
			</p>
			<div class="wipe-dialog__actions">
				<button class="wipe-dialog__cancel" type="button" onclick={() => wipeDialog?.close()}>
					Cancel
				</button>
				<button class="wipe-dialog__erase" type="button" onclick={() => void confirmErase()}>
					Erase everything
				</button>
			</div>
		</dialog>
	{/if}
{/if}

<style>
	h1 {
		margin: 0 0 var(--space-l);
	}

	.settings-section {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}

	.settings-section + .settings-section {
		margin-top: var(--space-l);
	}

	.settings-section__heading {
		margin: 0 0 var(--space-m);
	}

	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-m);
	}

	.settings-row__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.settings-row__label {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.settings-row__value {
		color: var(--color-fg);
	}

	/* Quiet action link: accent text, underline. */
	.settings-row__change {
		flex: none;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}

	.settings-edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
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

	/* Secondary/protective CTA: border + fg text, not destructive. */
	.settings-lock {
		padding: var(--space-s) var(--space-l);
		background: none;
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.settings-lock:hover {
		border-color: var(--color-fg-muted);
	}

	.settings-hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* Clock-backward reset control: the deliberate "I fixed my clock" reset the
	   app-wide ClockBackwardBanner's "Fix this" navigates to. Static --color-danger highlight
	   + inset bg makes it stand out among settings without animation (no-motion register). */
	.clock-notice {
		margin-top: var(--space-m);
		padding: var(--space-m);
		background: var(--color-bg);
		border-left: 3px solid var(--color-danger);
		border-radius: var(--radius-m);
	}

	.clock-notice__msg {
		margin: 0 0 var(--space-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.clock-notice__fix {
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}

	/* Danger zone: visually separated from benign actions above it. */
	.danger-zone {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}

	/* Destructive CTA: danger border + text, never a filled alarm. */
	.danger-cta {
		padding: var(--space-s) var(--space-l);
		background: none;
		color: var(--color-danger);
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.wipe-dialog {
		max-width: 28rem;
		padding: var(--space-l);
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
	}

	.wipe-dialog::backdrop {
		background: rgb(0 0 0 / 0.5);
	}

	.wipe-dialog__heading {
		margin: 0 0 var(--space-m);
	}

	.wipe-dialog__body {
		margin: 0 0 var(--space-l);
		color: var(--color-fg-muted);
	}

	.wipe-dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-m);
	}

	/* Cancel is the prominent, focused default (filled primary) so the safe choice is the
	   obvious one - accidental-wipe defense, especially as the profile grows. */
	.wipe-dialog__cancel {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.wipe-dialog__cancel:hover {
		background: var(--color-accent-muted);
	}

	/* Destructive confirm de-emphasized (quiet danger text): available, but low-salience so it
	   takes deliberate aim rather than a reflexive click. */
	.wipe-dialog__erase {
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-danger);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
