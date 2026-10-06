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
	const inUse = $derived(!!(leaving?.skillbridgeStart || leaving?.terminalLeaveStart));
	// Held here so the sentence stays on one source line: a line break inside it would reach the page's text.
	const NOT_USED = "is after your separation date, so it isn't used.";
</script>

<!-- The link is a fixed path: no query and no stored flag, so nothing about the dates reaches a URL. Each date sits in
     a span of its own, so a date that does not fit takes the next line whole. -->
<p class="leaving-line">
	{#if notUsed}
		Your {notUsed.what} date (<span class="leaving-line__date">{f(notUsed.iso)}</span>) {NOT_USED}
		<a href={resolve('/settings')}>Change</a>
	{:else if inUse}
		{#if leaving?.skillbridgeStart}SkillBridge from <span class="leaving-line__date"
				>{f(leaving.skillbridgeStart)}</span
			>.{/if}
		{#if leaving?.terminalLeaveStart}Terminal leave from <span class="leaving-line__date"
				>{f(leaving.terminalLeaveStart)}</span
			>.{/if}
		<a href={resolve('/settings')}>Change</a>
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
	/* A date reads as one piece: when it does not fit after the words before it, the whole date takes the next line. */
	.leaving-line__date {
		white-space: nowrap;
	}
</style>
