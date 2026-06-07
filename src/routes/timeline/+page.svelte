<script lang="ts">
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import SetupCTA from '$lib/components/SetupCTA.svelte';
	import TimelineList from '$lib/components/TimelineList.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { generateTimeline, TASK_DEFS, type TimelineState, type TaskStatus } from '$lib/timeline';
	import { formatTimelineDate } from '$lib/timeline/format-date';

	const app = getProfileApp();

	let unlocking = $state(false);

	// Until the timeline-state store provisions (async, after the profile store), fall back to
	// empty state so the timeline still renders with date-derived statuses; stored done/skip/
	// snooze (set via the C4 actions) layer in once the store loads.
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

	// C4: a status action -> the encrypted timeline store. On any write failure (incl. an OCC
	// conflict from a concurrent tab) reload authoritative state rather than clobber (spec
	// section 9); the view re-derives. No-op until the store has provisioned.
	async function setStatus(taskId: string, status: TaskStatus | undefined): Promise<void> {
		const timeline = app.timeline;
		if (!timeline) return;
		try {
			await timeline.setStatus(taskId, status);
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
			<TimelineList {view} onSetStatus={setStatus} />
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
