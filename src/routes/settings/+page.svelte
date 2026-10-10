<script lang="ts">
	import SettingsDateRow from '$lib/components/SettingsDateRow.svelte';
	import SkillBridgePlanRow from '$lib/components/SkillBridgePlanRow.svelte';
	import ThemeControl from '$lib/components/ThemeControl.svelte';
	import InstallPrompt from '$lib/components/InstallPrompt.svelte';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { getInstallApp } from '$lib/install/context';
	import { eraseEverything } from '$lib/profile/erase';
	import { OccConflictError, type ProfilePatch } from '$lib/profile/store.svelte';
	import {
		LEAVING_HINT,
		PAYGRADE_NOTE,
		ORDER_NOTE,
		AFTER_SEPARATION,
		AFTER_SKILLBRIDGE,
		BEFORE_TERMINAL_LEAVE
	} from '$lib/profile/leaving-copy';
	import {
		validateEaosAtInput,
		encodeEaos,
		EaosFormatError,
		type EaosCause
	} from '$lib/profile/eaos';
	import CalendarPanel from '$lib/components/CalendarPanel.svelte';
	import OnlineAnswersPanel from '$lib/components/OnlineAnswersPanel.svelte';
	import {
		getDefaultMode,
		setDefaultMode,
		isSynthesisEnabled,
		setSynthesisEnabled
	} from '$lib/ask/online-prefs';
	import { handOver } from '$lib/calendar/hand-over';
	import { staleEvents } from '$lib/calendar/handed-over';
	import { computeDesiredEvents } from '$lib/calendar/desired';
	import { localTodayIso } from '$lib/timeline/day-math';
	import { LocalToday } from '$lib/timeline/local-today.svelte';
	import { readablePlan, type PlanAnswer } from '$lib/timeline/skillbridge-plan';
	import { savePlanAnswer } from '$lib/timeline/skillbridge-save';
	import { generateTimeline, TASK_DEFS, type TimelineState } from '$lib/timeline';
	import { resolve } from '$app/paths';
	import { documentStates } from '$lib/sources/document-states';
	import { LOCAL_DOCUMENT_BYTES, LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';
	import { heldBytes, listCachedDocuments, stopSaves } from '$lib/sources/document-cache';

	const app = getProfileApp();
	const install = getInstallApp();
	// Everything derived from today reads this clock, which turns at local midnight; an act at a tap reads the clock at the tap.
	const clock = new LocalToday();

	// The Documents row's summary, read from the asset cache on arrival like the Documents page itself. It
	// counts from the paths and sizes alone; the titles stay with the Documents page, which shows them.
	let heldDocuments = $state<string[]>([]);
	$effect(() => {
		void listCachedDocuments().then((paths) => (heldDocuments = paths));
	});
	const documentCount = Object.keys(LOCAL_DOCUMENTS).length;
	const states = $derived(documentStates(heldDocuments, LOCAL_DOCUMENTS));
	const savedDocuments = $derived(
		Object.entries(states)
			.filter(([, held]) => held.state === 'saved')
			.map(([sourceId]) => sourceId)
	);
	// The older copies an update left, counted as the Documents page counts them: sized from the device, and
	// without a size when the device would not give it.
	let older = $state<{ count: number; bytes: number | null }>({ count: 0, bytes: 0 });
	$effect(() => {
		const stale = Object.values(states).flatMap((held) => held.stale);
		let cancelled = false;
		void heldBytes(stale).then((bytes) => {
			if (!cancelled) older = { count: stale.length, bytes };
		});
		return () => {
			cancelled = true;
		};
	});
	const savedMb = $derived(
		`${(savedDocuments.reduce((total, id) => total + (LOCAL_DOCUMENT_BYTES[id] ?? 0), 0) / 1e6).toFixed(1)} MB`
	);

	// Online-answers settings: non-PII device prefs + whether a BYO key is stored (presence only).
	let defaultMode = $state<'device' | 'online'>(getDefaultMode());
	let synthesisEnabled = $state(isSynthesisEnabled());
	let hasKey = $state(false);
	$effect(() => {
		const locked = app.store?.locked ?? true;
		if (app.byok && !locked) {
			void app.byok
				.readApiKey()
				.then((k) => (hasKey = k !== null))
				.catch(() => (hasKey = false));
		}
	});

	// A no-timeline profile can still configure "Online answers" here, so Settings stays reachable - but the
	// timeline-dependent sections (separation date, calendar) hide until there is a timeline to manage.
	const hasTimeline = $derived((app.store?.persona.completeness ?? 'none') !== 'none');

	let unlocking = $state(false);
	let wipeDialog = $state<HTMLDialogElement | null>(null);
	let clockFixEl = $state<HTMLButtonElement | null>(null);
	let clockError = $state<string | null>(null);
	let eraseError = $state<string | null>(null);

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

	const OCC_MESSAGE =
		'This was changed in another tab. We reloaded it - please review and save again.';
	// The leaving rows are not the separation date, so an empty or unreadable entry asks for "a valid date".
	const LEAVING_ERROR_COPY: Record<EaosCause, string> = {
		...ERROR_COPY,
		format: 'Please enter a valid date.'
	};

	const leaving = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.leaving : undefined;
	});
	// Each row shows its stored date, in use or not (the Timeline line says when one is not used).
	const skillbridgeValue = $derived(
		leaving?.skillbridgeStart ?? leaving?.notUsed?.skillbridgeStart ?? null
	);
	const terminalLeaveValue = $derived(
		leaving?.terminalLeaveStart ?? leaving?.notUsed?.terminalLeaveStart ?? null
	);
	const outOfOrder = $derived(
		!!leaving?.skillbridgeStart &&
			!!leaving.terminalLeaveStart &&
			leaving.skillbridgeStart >= leaving.terminalLeaveStart
	);

	// The answer lives in the timeline store, which can still be loading, locked or failed while the profile is open:
	// the row shows a value and offers Save only once that store is readable.
	const plan = $derived(readablePlan(app.timeline, currentEaos, localTodayIso(clock.now)));

	async function savePlan(answer: PlanAnswer): Promise<string | null> {
		const timeline = app.timeline;
		if (!timeline || !currentEaos) throw new Error('E_NO_TIMELINE');
		try {
			await savePlanAnswer(timeline, answer, currentEaos, localTodayIso(new Date()));
			return null;
		} catch (err) {
			if (err instanceof OccConflictError) return OCC_MESSAGE;
			throw err;
		}
	}

	/** A typed date as bytes, or the message to show; the input range is the separation date's own. */
	function readDate(draft: string, copy: Record<EaosCause, string>): Uint8Array | string {
		try {
			return encodeEaos(validateEaosAtInput(draft));
		} catch (err) {
			if (err instanceof EaosFormatError) return copy[err.cause];
			throw err;
		}
	}

	async function savePatch(patch: ProfilePatch, bytes?: Uint8Array): Promise<string | null> {
		const store = app.store;
		if (!store) return null;
		try {
			await store.save(patch);
			return null;
		} catch (err) {
			if (err instanceof OccConflictError) {
				// refresh, not load: the user asked to save, not to unlock, so if the write lost its race to a
				// relock this must not re-open the store.
				await store.refresh();
				return OCC_MESSAGE;
			}
			throw err;
		} finally {
			bytes?.fill(0); // the store keeps its own copy; this one held the typed date
		}
	}

	async function saveEaos(draft: string): Promise<string | null> {
		const bytes = readDate(draft, ERROR_COPY);
		return typeof bytes === 'string' ? bytes : savePatch({ eaos: bytes }, bytes);
	}

	async function saveLeaving(
		field: 'skillbridgeStart' | 'terminalLeaveStart',
		draft: string
	): Promise<string | null> {
		const bytes = readDate(draft, LEAVING_ERROR_COPY);
		if (typeof bytes === 'string') return bytes;
		if (currentEaos && draft >= currentEaos) {
			bytes.fill(0);
			return AFTER_SEPARATION;
		}
		// Terminal leave follows SkillBridge (NAVADMIN 160/22 5.e), so a pair out of order or on one day is refused.
		// Only a used date holds the other back; one on or after separation is not used.
		const order =
			field === 'skillbridgeStart'
				? leaving?.terminalLeaveStart &&
					draft >= leaving.terminalLeaveStart &&
					BEFORE_TERMINAL_LEAVE
				: leaving?.skillbridgeStart && draft <= leaving.skillbridgeStart && AFTER_SKILLBRIDGE;
		if (order) {
			bytes.fill(0);
			return order;
		}
		const patch: ProfilePatch =
			field === 'skillbridgeStart' ? { skillbridgeStart: bytes } : { terminalLeaveStart: bytes };
		return savePatch(patch, bytes);
	}

	function removeLeaving(field: 'skillbridgeStart' | 'terminalLeaveStart'): Promise<string | null> {
		// An absent key is "not set": the store drops it and zeroizes the record it replaces.
		return savePatch(
			field === 'skillbridgeStart'
				? { skillbridgeStart: undefined }
				: { terminalLeaveStart: undefined }
		);
	}

	// Until the timeline-state store provisions, fall back to empty state so the calendar panel
	// still lists date-derived pending tasks; stored done/skip/snooze layer in once it loads. The add
	// itself waits for the real state (the panel's `ready` includes the timeline store's).
	const EMPTY_STATE: TimelineState = { schemaVersion: 1, tasks: {} };

	// The flat pending-task list the calendar panel projects to events - the timeline route's
	// generation, flattened across phases. Empty until a persona with an EAOS exists.
	const calendarItems = $derived.by(() => {
		const persona = app.store?.persona;
		if (!persona || persona.completeness === 'none') return [];
		const state = app.timeline?.state ?? EMPTY_STATE;
		return generateTimeline(persona, [...TASK_DEFS], state, clock.now).phases.flatMap(
			(p) => p.items
		);
	});

	// The events handed to the calendar that the file would no longer carry as they are.
	const stale = $derived.by(() => {
		const today = localTodayIso(clock.now);
		const exclusions = app.calendar?.exclusions ?? { taskIds: [], categories: [] };
		return staleEvents(
			app.calendar?.lastAdd,
			computeDesiredEvents(calendarItems, exclusions, today),
			today
		);
	});

	function lock(): void {
		// Every store, not just the profile: the timeline holds decrypted free-text task notes, and
		// leaving them in memory is precisely what this button exists to prevent.
		app.relockAll?.();
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
			// Clear failed (e.g. another tab edited concurrently); the store lowers the mark only when
			// the save lands, so the banner/notice correctly stay up. Tell the user they can retry.
			clockError = 'Could not update right now - please try again.';
		}
	}

	async function confirmErase(): Promise<void> {
		eraseError = null;
		wipeDialog?.close();
		try {
			await eraseEverything({
				relock: () => app.relockAll?.(),
				wipeAll: app.wipeAll,
				// Defensive: the app stores no PII outside IndexedDB, but the erase clears localStorage +
				// Cache Storage for completeness.
				// eslint-disable-next-line no-restricted-properties -- the erase also clears the device settings
				clearStorage: () => window.localStorage.clear(),
				clearCaches: async () => {
					if (!('caches' in window)) return;
					// A document save still writing would store its document again after the caches are gone.
					await stopSaves();
					const keys = await window.caches.keys();
					await Promise.all(keys.map((key) => window.caches.delete(key)));
				},
				// Reload -> app-init bootstraps a fresh keystore -> clean first-run state.
				reload: () => window.location.reload()
			});
		} catch (e) {
			// Damaged data that reads again is not erased: the page is already reloading onto it, and nothing failed. The
			// layout throws this fixed code; importing a class from its module here would split that module out of the
			// layout into a chunk every page downloads (measured: +219 B of page chunks).
			if (e instanceof Error && e.message === 'E_NO_LONGER_DAMAGED') return;
			// The erase refuses before touching disk unless it can clear every store, and the store
			// wipe is one transaction - so if we are here, nothing was destroyed. Saying so matters
			// more than usual: the user asked for their data to be gone and would otherwise walk away
			// believing it was, because the dialog closed and the screen locked.
			eraseError = 'Could not erase your data. Nothing was deleted - please try again.';
		}
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

<!-- A browser's page translation sends this screen's text to a translation service, and its dates reveal the
     separation date. -->
<div translate="no">
	<h1>Settings</h1>

	{#if app.status === 'ready'}
		<!-- Outside the locked/unlocked split on purpose: the erase zeroizes memory before it touches
	     disk, so by the time it can fail the store is already relocked and this whole page has
	     swapped to the locked panel. Rendered in the section that raised it, this message would be
	     unmounted before the user ever saw it. -->
		{#if eraseError}
			<p class="erase-error" role="alert">{eraseError}</p>
		{/if}
		<!-- Above the lock gate on purpose: the theme is a non-PII device preference, so an idle-locked
	     user can still switch light/dark without unlocking. -->
		<section class="settings-section" aria-labelledby="appearance-heading">
			<h2 id="appearance-heading" class="settings-section__heading">Appearance</h2>
			<div class="settings-row appearance-row">
				<div class="settings-row__field">
					<span class="settings-row__label">Theme</span>
					<span class="settings-row__value">Light, dark, or match your device.</span>
				</div>
				<ThemeControl />
			</div>
		</section>
		<!-- Install control: non-PII + device-level, so it sits above the lock gate like Appearance.
	     Permanent (no dismiss) - a user who dismissed the Home nudge can still install from here. -->
		{#if install.installed}
			<section class="settings-section" aria-labelledby="install-heading">
				<h2 id="install-heading" class="settings-section__heading">Install</h2>
				{#if install.persisted}
					<p class="settings-hint">
						Ask 214 is installed, and its data is set to stay on this device.
					</p>
				{:else}
					<p class="settings-hint">Ask 214 is installed on this device.</p>
				{/if}
			</section>
		{:else}
			<section class="settings-section" aria-labelledby="install-heading">
				<h2 id="install-heading" class="settings-section__heading">Install Ask 214</h2>
				<p class="settings-hint">
					Install it so it opens like an app and is less likely to have its data cleared.
				</p>
				{#if install.canPrompt || install.ios}
					<InstallPrompt
						canPrompt={install.canPrompt}
						onInstall={() => void install.promptInstall()}
					/>
				{:else}
					<p class="settings-hint">
						If your browser supports it, open its menu and choose Install or Add to Home Screen.
					</p>
				{/if}
			</section>
		{/if}
		<!-- Documents: public government guides, no personal data, so like Install it sits above the lock gate
	     and a user with no timeline still reaches them. -->
		<section class="settings-section" aria-labelledby="documents-heading">
			<h2 id="documents-heading" class="settings-section__heading">Documents</h2>
			<div class="documents-summary">
				<span
					>{savedDocuments.length} of {documentCount} saved on this device - {savedMb}{older.count >
					0
						? `, plus ${older.count} older ${older.count === 1 ? 'copy' : 'copies'}${older.bytes === null ? '' : ` (${(older.bytes / 1e6).toFixed(1)} MB)`}`
						: ''}</span
				>
				<a class="documents-manage" href={resolve('/documents')}>Manage documents</a>
			</div>
			<p class="settings-hint">
				Read the official guides behind the answers, and choose which stay on this device.
			</p>
		</section>
		{#if app.store?.locked}
			<LockedPanel onunlock={() => void unlock()} busy={unlocking} />
		{:else}
			{#if hasTimeline}
				<section class="settings-section" aria-labelledby="timeline-heading">
					<h2 id="timeline-heading" class="settings-section__heading">Transition timeline</h2>

					<SettingsDateRow
						id="eaos"
						label="Separation date (EAOS)"
						value={currentEaos}
						hint="Your End of Active Obligated Service - the date your current obligation ends."
						onSave={saveEaos}
					/>
					<SkillBridgePlanRow {plan} onSave={savePlan} />
					<SettingsDateRow
						id="skillbridge-start"
						label="SkillBridge start"
						value={skillbridgeValue}
						hint={PAYGRADE_NOTE}
						onSave={(d) => saveLeaving('skillbridgeStart', d)}
						onRemove={() => removeLeaving('skillbridgeStart')}
					/>
					<SettingsDateRow
						id="terminal-leave-start"
						label="Terminal leave start"
						value={terminalLeaveValue}
						hint=""
						onSave={(d) => saveLeaving('terminalLeaveStart', d)}
						onRemove={() => removeLeaving('terminalLeaveStart')}
					/>
					<p class="settings-hint">{LEAVING_HINT}</p>
					{#if outOfOrder}<p class="settings-hint">{ORDER_NOTE}</p>{/if}

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
			{/if}

			{#if hasTimeline}
				<section class="settings-section" aria-labelledby="privacy-heading">
					<h2 id="privacy-heading" class="settings-section__heading">Privacy and security</h2>
					<button class="settings-lock" type="button" onclick={lock}>Lock</button>
					<p class="settings-hint">
						Clears your profile from this screen. Use Unlock to view it again.
					</p>

					<div class="danger-zone">
						<button class="danger-cta" type="button" onclick={() => wipeDialog?.showModal()}>
							Erase all data on this device
						</button>
					</div>
				</section>
			{/if}

			{#if hasTimeline}
				<CalendarPanel
					items={calendarItems}
					exclusions={app.calendar?.exclusions ?? { taskIds: [], categories: [] }}
					ready={(app.calendar?.ready ?? false) &&
						(app.timeline?.ready ?? false) &&
						!(app.timeline?.failed ?? false)}
					onSetExclusions={(next) =>
						app.calendar
							? app.calendar.setExclusions(next).catch(async (err) => {
									await app.calendar?.refresh();
									throw err;
								})
							: Promise.resolve()}
					onAdd={(file) => void handOver(file, app.calendar, new Date())}
					{stale}
					onAcknowledge={() =>
						app.calendar
							? app.calendar.acknowledgeStale(stale).catch(async (err) => {
									await app.calendar?.refresh();
									throw err;
								})
							: Promise.resolve()}
				/>
			{/if}

			<OnlineAnswersPanel
				{defaultMode}
				{synthesisEnabled}
				{hasKey}
				onSetDefaultMode={(m) => {
					defaultMode = m;
					setDefaultMode(m);
				}}
				onToggleSynthesis={(on) => {
					synthesisEnabled = on;
					setSynthesisEnabled(on);
				}}
				onSaveKey={async (k) => {
					if (!app.byok) return;
					await app.byok.saveApiKey(k);
					hasKey = true;
				}}
				onClearKey={async () => {
					if (!app.byok) return;
					await app.byok.clearApiKey();
					hasKey = false;
				}}
			/>

			{@render eraseDialog()}
		{/if}
	{:else if app.status === 'damaged'}
		<!-- The saved data failed its own checks at start-up, so no reload can read it: only the way back is offered - the
	     same erase, from the same dialog. -->
		{#if eraseError}
			<p class="erase-error" role="alert">{eraseError}</p>
		{/if}
		<section class="settings-section" aria-labelledby="privacy-heading">
			<h2 id="privacy-heading" class="settings-section__heading">Privacy and security</h2>
			<button class="danger-cta" type="button" onclick={() => wipeDialog?.showModal()}>
				Erase all data on this device
			</button>
			<p class="settings-hint">
				Erasing removes everything saved on this device, so the app can start again.
			</p>
		</section>
		{@render eraseDialog()}
	{/if}

	{#snippet eraseDialog()}
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
	{/snippet}
</div>

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

	/* The theme control is wider than the EAOS "Change" link. Let the Appearance row wrap, and on a
	   phone width stack it so the control drops below the label instead of being clipped. */
	.appearance-row {
		flex-wrap: wrap;
	}

	@media (max-width: 600px) {
		.appearance-row {
			flex-direction: column;
			align-items: flex-start;
		}
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

	.documents-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-s) var(--space-m);
	}

	/* The outline button the Documents page uses, on a link because it navigates. */
	.documents-manage {
		display: inline-block;
		padding: 6px var(--space-m);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-s);
		color: var(--color-accent);
		font-size: var(--font-size-s);
		font-weight: 600;
		text-decoration: none;
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

	.erase-error {
		margin: 0 0 var(--space-l);
		color: var(--color-danger);
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
