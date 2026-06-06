<script lang="ts">
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import SetupCTA from '$lib/components/SetupCTA.svelte';
	import { getProfileApp } from '$lib/profile/context';

	const app = getProfileApp();

	let unlocking = $state(false);

	// Stored EAOS (string form) via the derived persona, or null when unset - mirrors Settings.
	const eaos = $derived.by(() => {
		const p = app.store?.persona;
		return p && p.completeness !== 'none' ? p.eaos : null;
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
	{:else}
		<p class="timeline-subline">Anchored to {eaos} - tracking your 24-month runway.</p>
		<!-- C3: TimelineList (phase sections + status task cards) mounts here. -->
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
