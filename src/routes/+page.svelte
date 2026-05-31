<script lang="ts">
	import { resolve } from '$app/paths';
	import SetupCTA from '$lib/components/SetupCTA.svelte';
	import { getProfileApp } from '$lib/profile/context';

	const app = getProfileApp();
</script>

<svelte:head>
	<title>Transition Companion</title>
	<meta
		name="description"
		content="Privacy-first companion for US transitioning service members."
	/>
</svelte:head>

{#if app.status === 'ready' && app.store?.persona.completeness === 'none'}
	<SetupCTA />
{/if}

<h1>Transition Companion</h1>

<p>
	A privacy-first companion for US transitioning service members. This is the v1.0 scaffold -
	features arrive in subsequent phases.
</p>

<p>
	Currently in early development. See <a href={resolve('/about')}>About</a> for the project mission and
	privacy stance.
</p>
