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
	const showCalendarCard = $derived(
		calendarItems.length > 0 && shouldShowCalendarCard(app.calendar?.card ?? {}, Date.now())
	);

	async function unlock(): Promise<void> {
		const store = app.store;
		if (!store) return;
		unlocking = true;
		try {
			await store.load();
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
			await timeline.load();
		}
	}

	// Snooze a task until an ISO date; same OCC-safe reload as setStatus.
	async function setSnooze(taskId: string, untilIso: string): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setSnooze(taskId, untilIso);
		} catch {
			await timeline.load();
		}
	}

	// Set or clear a free-text note; same OCC-safe reload as the other actions.
	async function setNote(taskId: string, note: string | undefined): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setNote(taskId, note);
		} catch {
			await timeline.load();
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
