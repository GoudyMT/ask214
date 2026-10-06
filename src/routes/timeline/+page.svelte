<script lang="ts">
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

	const app = getProfileApp();

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
	// per-task state changes. TASK_DEFS is readonly; generateTimeline takes a mutable array.
	const view = $derived.by(() => {
		const persona = app.store?.persona;
		if (!persona || persona.completeness === 'none') return null;
		const state = app.timeline?.state ?? EMPTY_STATE;
		return generateTimeline(persona, [...TASK_DEFS], state, new Date());
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

	// A status action -> the encrypted timeline store. On any write failure (incl. an OCC
	// conflict from a concurrent tab) reload authoritative state rather than clobber; the
	// view re-derives. No-op until the store has provisioned.
	async function setStatus(taskId: string, status: TaskStatus | undefined): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setStatus(taskId, status);
		} catch {
			await timeline.refresh();
		}
	}

	// Snooze a task until an ISO date; same OCC-safe reload as setStatus.
	async function setSnooze(taskId: string, untilIso: string): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setSnooze(taskId, untilIso);
		} catch {
			await timeline.refresh();
		}
	}

	// Set or clear a free-text note; same OCC-safe reload as the other actions.
	async function setNote(taskId: string, note: string | undefined): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setNote(taskId, note);
		} catch {
			await timeline.refresh();
		}
	}
</script>

<svelte:head>
	<title>Timeline</title>
</svelte:head>

<h1>Timeline</h1>

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
			{#if showCalendarCard}
				<CalendarCard
					items={calendarItems}
					exclusions={app.calendar?.exclusions ?? { taskIds: [], categories: [] }}
					onAdd={(file) => void handOver(file, app.calendar, new Date())}
					onDismiss={() => void app.calendar?.dismissCard(Date.now())}
				/>
			{/if}
			<PhaseChips {view} />
			<TimelineList {view} onSetStatus={setStatus} onSetSnooze={setSnooze} onSetNote={setNote} />
		{/if}
	{/if}
{/if}

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
