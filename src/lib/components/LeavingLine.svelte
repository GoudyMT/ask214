<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { LeavingDates } from '$lib/profile/persona';

	let { leaving }: { leaving: LeavingDates | undefined } = $props();

	const f = formatTimelineDate;
	const notUsed = $derived(
		leaving?.notUsed?.terminalLeaveStart
			? { what: 'terminal leave', iso: leaving.notUsed.terminalLeaveStart }
			: leaving?.notUsed?.skillbridgeStart
				? { what: 'SkillBridge', iso: leaving.notUsed.skillbridgeStart }
				: null
	);
	const inUse = $derived(
		[
			leaving?.skillbridgeStart ? `SkillBridge from ${f(leaving.skillbridgeStart)}.` : null,
			leaving?.terminalLeaveStart ? `Terminal leave from ${f(leaving.terminalLeaveStart)}.` : null
		].filter((s): s is string => s !== null)
	);
</script>

<!-- The link is a fixed path: no query and no stored flag, so nothing about the dates reaches a URL. -->
<p class="leaving-line">
	{#if notUsed}
		Your {notUsed.what} date ({f(notUsed.iso)}) is after your separation date, so it isn't used.
		<a href={resolve('/settings')}>Change</a>
	{:else if inUse.length > 0}
		{inUse.join(' ')} <a href={resolve('/settings')}>Change</a>
	{:else}
		Doing SkillBridge or taking terminal leave? <a href={resolve('/settings')}
			>Add your dates in Settings</a
		>
	{/if}
</p>

<style>
	/* One quiet line under the subline, where the separation date already shows. */
	.leaving-line {
		margin: 0 0 var(--space-l);
		font-size: var(--font-size-s);
	}
	.leaving-line a {
		color: var(--color-accent);
	}
</style>
