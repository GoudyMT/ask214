<script lang="ts">
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import SetupCTA from '$lib/components/SetupCTA.svelte';
	import TimelineList from '$lib/components/TimelineList.svelte';
	import PhaseChips from '$lib/components/PhaseChips.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { generateTimeline, TASK_DEFS, type TimelineState, type TaskStatus } from '$lib/timeline';
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import CalendarCard from '$lib/components/CalendarCard.svelte';
	import { downloadTextFile } from '$lib/calendar/download';
	import { shouldShowCalendarCard } from '$lib/calendar/card-visibility';

	const app = getProfileApp();

	let unlocking = $state(false);

	// Until the timeline-state store provisions (async, after the profile store), fall back to
	// empty state so the timeline still renders with date-derived statuses; stored done/skip/
	// snooze (set via the status actions) layer in once the store loads.
	const EMPTY_STATE: TimelineState = { schemaVersion: 1, tasks: {} };

	// Stored EAOS (string form) via the derived persona, or null when unset - mirrors Settings.
	const eaos = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.eaos : null;
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

	// The card is the discoverable entry point for the calendar add. It respects the dismissal
	// cooldown + cap, and stays hidden when there is nothing to add.
	//
	// Fail closed on `ready`: until the store loads, both the dismissal state and the exclusion set
	// are UNKNOWN, not empty. Rendering then would nag a user who already answered AND offer a
	// one-tap export built from an exclusion set we cannot vouch for.
	const showCalendarCard = $derived(
		calendarItems.length > 0 &&
			(app.calendar?.ready ?? false) &&
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
			// The calendar then fails closed on `ready`; the TIMELINE DOES NOT - it has no ready gate,
			// so a failed load here renders an empty timeline as though nothing were done. The store
			// refuses the write, so nothing is destroyed, but the user is shown a blank slate with no
			// explanation. Surfacing that is deferred to the v1.1 init-error work.
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
	{#if app.store?.locked}
		<LockedPanel onunlock={() => void unlock()} busy={unlocking} />
	{:else if app.store?.persona.completeness === 'none'}
		<SetupCTA />
	{:else if eaos}
		<p class="timeline-subline">
			Anchored to {formatTimelineDate(eaos)} - tracking your 24-month runway.
		</p>
		{#if view}
			{#if showCalendarCard}
				<CalendarCard
					items={calendarItems}
					exclusions={app.calendar?.exclusions ?? { taskIds: [], categories: [] }}
					onDownload={(ics) => downloadTextFile('transition-deadlines.ics', 'text/calendar', ics)}
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
		margin: 0 0 var(--space-l);
		color: var(--color-fg-muted);
	}
</style>
