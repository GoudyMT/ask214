<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import SetupCTA from '$lib/components/SetupCTA.svelte';
	import TimelineList from '$lib/components/TimelineList.svelte';
	import PhaseChips from '$lib/components/PhaseChips.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { generateTimeline, TASK_DEFS, type TimelineState, type TaskStatus } from '$lib/timeline';
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import CalendarCard from '$lib/components/CalendarCard.svelte';
	import NeedsNow from '$lib/components/NeedsNow.svelte';
	import { handOver } from '$lib/calendar/hand-over';
	import { shouldShowCalendarCard } from '$lib/calendar/card-visibility';
	import { selectNeedsNow } from '$lib/timeline/needs-now';
	import { computeDesiredEvents } from '$lib/calendar/desired';
	import LeavingLine from '$lib/components/LeavingLine.svelte';
	import SkillBridgeQuestion from '$lib/components/SkillBridgeQuestion.svelte';
	import { readablePlan, type PlanAnswer } from '$lib/timeline/skillbridge-plan';
	import { savePlanAnswer } from '$lib/timeline/skillbridge-save';
	import { localTodayIso } from '$lib/timeline/day-math';
	import { LocalToday } from '$lib/timeline/local-today.svelte';

	const app = getProfileApp();
	// Everything derived from today reads this clock, which turns at local midnight; an act at a tap reads the clock at the tap.
	const clock = new LocalToday();

	let unlocking = $state(false);

	// Until the timeline-state store loads (async, after the profile store), the view is built from an empty state. The
	// list and the calendar card render only once the store is `ready`, so nothing shows a task as not started that the
	// user marked done; a failed load shows a note instead (below).
	const EMPTY_STATE: TimelineState = { schemaVersion: 1, tasks: {} };

	// Stored EAOS (string form) via the derived persona, or null when unset - mirrors Settings.
	const eaos = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.eaos : null;
	});

	const leaving = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.leaving : undefined;
	});

	// The generated timeline projection (pure): re-derives when the persona or the stored
	// per-task state changes, and when the day turns at local midnight. TASK_DEFS is readonly;
	// generateTimeline takes a mutable array.
	const view = $derived.by(() => {
		const persona = app.store?.persona;
		if (!persona || persona.completeness === 'none') return null;
		const state = app.timeline?.state ?? EMPTY_STATE;
		return generateTimeline(persona, [...TASK_DEFS], state, clock.now);
	});

	// The flat pending-task list the calendar card projects to events (same shared projection the
	// Settings panel uses, so both surfaces egress identically).
	const calendarItems = $derived(view ? view.phases.flatMap((p) => p.items) : []);
	const needsNow = $derived(view?.todayDate ? selectNeedsNow(calendarItems, view.todayDate) : null);

	// The card is the discoverable entry point for the calendar add. It respects the dismissal
	// cooldown + cap, and stays hidden when there is nothing to add: no event today or later once the
	// exclusions apply.
	//
	// Fail closed on `ready`: until the store loads, both the dismissal state and the exclusion set
	// are UNKNOWN, not empty. Rendering then would nag a user who already answered AND offer a
	// one-tap export built from an exclusion set we cannot vouch for.
	const hasEventsToAdd = $derived(
		view?.todayDate !== undefined &&
			computeDesiredEvents(
				calendarItems,
				app.calendar?.exclusions ?? { taskIds: [], categories: [] },
				view.todayDate
			).length > 0
	);
	const showCalendarCard = $derived(
		hasEventsToAdd &&
			(app.calendar?.ready ?? false) &&
			(app.timeline?.ready ?? false) &&
			shouldShowCalendarCard(app.calendar?.card ?? {}, Date.now())
	);

	const plan = $derived(readablePlan(app.timeline, eaos, localTodayIso(clock.now)));
	// Set at the tap, before the save lands: the store's answer ends the question, but the card stays on the page to show
	// what happened, until the person closes it or leaves.
	let planHeld = $state(false);
	// A close holds for the rest of the visit, even if the question comes due again while the message is open.
	let planClosed = $state(false);
	// With no readable answer (locked, loading, failed) the card is gone and remounts fresh; a hold left over would ask
	// again, and a second tap would overwrite the saved answer.
	$effect.pre(() => {
		if (!plan) planHeld = false;
	});

	// The SkillBridge answer -> the encrypted timeline store, through the shared save (it re-reads the store on a
	// failure); a rejection reaches the card, which says the save failed. Resolves to the save's return day for the card's line.
	async function answerPlan(answer: PlanAnswer): Promise<string | null> {
		const timeline = app.timeline;
		if (!timeline || !eaos) throw new Error('E_NO_TIMELINE');
		planHeld = true;
		try {
			return await savePlanAnswer(timeline, answer, eaos, localTodayIso(new Date()));
		} catch (err) {
			// The re-read may show the question answered in another tab; then the card goes, as after an answer here.
			planHeld = false;
			if (!plan?.card) await focusAfterCard();
			throw err;
		}
	}

	// A card that held focus is gone (closed, or removed by a re-read); focus goes to the next thing the person would
	// act on, so a keyboard or screen-reader user is not dropped back at the top of the page. A fully resolved phase is
	// collapsed, so its tasks are not on the page: its toggle comes next, and the heading when there is no list at all.
	async function focusAfterCard(): Promise<void> {
		await tick();
		// Focus that is already somewhere on the page stays: the person moved on while the card was still up.
		if (document.activeElement !== document.body) return;
		for (const selector of ['.cal-card__add', '[id^="task-"]', '.timeline-list__toggle', 'h1']) {
			const next = document.querySelector<HTMLElement>(selector);
			if (next) return next.focus();
		}
	}

	// The close moves the calendar card up under the spot of the close button and focus onto its Add button, so a second
	// tap or key on the button (a double click, a held Enter) would dismiss or download. These handlers wait out a
	// double-click's time; a tap after reading still works.
	const CLOSE_GUARD_MS = 500;
	let closedAt = 0;
	const justClosed = () => Date.now() - closedAt < CLOSE_GUARD_MS;

	async function closePlan(): Promise<void> {
		closedAt = Date.now();
		planClosed = true;
		await focusAfterCard();
	}

	async function unlock(): Promise<void> {
		const store = app.store;
		if (!store) return;
		unlocking = true;
		try {
			await store.load();
			// The secondary stores relock alongside the profile on idle/pagehide but are not part of
			// the profile's load. Without this they stay unloaded behind an unlocked UI and their empty
			// defaults read as real state. allSettled: a secondary failure must not block the unlock.
			// Both then fail closed on `ready`, and a timeline load that fails says so in place of the list
			// (the store's `failed`).
			await Promise.allSettled([app.timeline?.load(), app.calendar?.load()]);
		} finally {
			unlocking = false;
		}
	}

	// Runs a write to a store; true when it landed. On any failure (incl. an OCC conflict from a concurrent tab) the store
	// is read again rather than clobbered, so the view re-derives. A re-read that fails too is not passed on: the store
	// then reads as unavailable (the timeline's failed flag shows the page's note; a calendar that is not ready takes its
	// card away), and a rejection nothing awaits would reach the console as unhandled.
	async function attempt(
		store: { refresh(): Promise<void> },
		write: () => Promise<void>
	): Promise<boolean> {
		try {
			await write();
			return true;
		} catch {
			try {
				await store.refresh();
			} catch {
				// Shown by the store reading as unavailable.
			}
			return false;
		}
	}

	// A status action -> the encrypted timeline store. No-op until the store has provisioned.
	async function setStatus(taskId: string, status: TaskStatus | undefined): Promise<void> {
		const timeline = app.timeline;
		if (timeline) await attempt(timeline, () => timeline.setStatus(taskId, status));
	}

	// Snooze a task until an ISO date; same OCC-safe reload as setStatus.
	async function setSnooze(taskId: string, untilIso: string): Promise<void> {
		const timeline = app.timeline;
		if (timeline) await attempt(timeline, () => timeline.setSnooze(taskId, untilIso));
	}

	// Set or clear a free-text note; same OCC-safe reload as the other actions. The card waits on this, so a failed save
	// is told to it (and it keeps the typed text) after the re-read.
	async function setNote(taskId: string, note: string | undefined): Promise<void> {
		const timeline = app.timeline;
		if (timeline && !(await attempt(timeline, () => timeline.setNote(taskId, note)))) {
			throw new Error('E_NOTE_SAVE');
		}
	}

	// The calendar card's Dismiss. A landed write removes the card, and so can the re-read after a failed one (a peer
	// dismissed it, or the calendar could not be read): focus that sat on its button then goes to the next thing to act on.
	// A card that stays up keeps the focus, which focusAfterCard leaves alone.
	async function dismissCalendarCard(): Promise<void> {
		const calendar = app.calendar;
		if (!calendar || justClosed()) return;
		await attempt(calendar, () => calendar.dismissCard(Date.now()));
		await focusAfterCard();
	}
</script>

<svelte:head>
	<title>Timeline</title>
</svelte:head>

<!-- A browser's page translation sends this screen's text to a translation service, and its dates reveal the
     separation date. -->
<div translate="no">
	<h1 tabindex="-1">Timeline</h1>

	{#if app.status === 'ready'}
		<!-- The timeline can stay locked after the profile opens (a page hidden while Unlock read it); Unlock reads it again.
	     Unless its load failed: then the note below says so, since Unlock would only fail again. And only with something
	     saved: a first run has nothing to unlock, so it keeps the setup. -->
		{#if app.store?.locked || (app.timeline?.locked && !app.timeline.failed && app.store?.persona.completeness !== 'none')}
			<LockedPanel onunlock={() => void unlock()} busy={unlocking} />
		{:else if app.store?.persona.completeness === 'none'}
			<SetupCTA />
		{:else if eaos}
			<p class="timeline-subline">
				Anchored to {formatTimelineDate(eaos)} - tracking your 24-month runway.
			</p>
			<LeavingLine {leaving} />
			<!-- The list waits for the saved progress: drawn without it, every task shows as not started. A load that failed
		     says so in its place, where a list would read as lost progress and its buttons would do nothing. -->
			{#if view && app.timeline?.failed}
				<div class="timeline-note">
					<p class="timeline-note__msg" role="alert">
						Your saved progress couldn't be loaded, so your tasks aren't shown. Reload to try again.
						If it keeps happening, you can erase all data in <a href={resolve('/settings')}
							>Settings</a
						> and start again.
					</p>
					<button class="timeline-note__reload" type="button" onclick={() => location.reload()}
						>Reload</button
					>
				</div>
			{:else if view && app.timeline?.ready}
				{#if needsNow}<NeedsNow groups={needsNow} />{/if}
				{#if plan && !planClosed && (plan.card || planHeld)}
					<SkillBridgeQuestion
						wording={plan.card ?? 'again'}
						onAnswer={answerPlan}
						onClose={() => void closePlan()}
					/>
				{/if}
				{#if showCalendarCard}
					<CalendarCard
						items={calendarItems}
						exclusions={app.calendar?.exclusions ?? { taskIds: [], categories: [] }}
						onAdd={(file) => {
							if (!justClosed()) void handOver(file, app.calendar, new Date());
						}}
						onDismiss={dismissCalendarCard}
					/>
				{/if}
				<PhaseChips {view} />
				<TimelineList {view} onSetStatus={setStatus} onSetSnooze={setSnooze} onSetNote={setNote} />
			{/if}
		{/if}
	{/if}
</div>

<style>
	h1 {
		margin: 0 0 var(--space-s);
	}

	.timeline-subline {
		margin: 0 0 var(--space-xs);
		color: var(--color-fg-muted);
	}

	/* The start-up banner's look (InitErrorBanner), inside the page: surface, a 3 px danger edge. */
	.timeline-note {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-danger);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
	}

	.timeline-note__msg {
		margin: 0;
	}

	.timeline-note__msg a {
		color: var(--color-accent);
	}

	/* The banner's Reload: a 44 px target with the text-link look. */
	.timeline-note__reload {
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
