<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	// This page serves every failure, a server fault included, so only a missing page is called "not found".
	const missing = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{missing ? 'Page not found - Ask 214' : 'Ask 214'}</title>
</svelte:head>

{#if missing}
	<h1>Page not found</h1>
	<p>This page does not exist.</p>
{:else}
	<h1>{page.status} - {page.error?.message}</h1>
{/if}

<p><a href={resolve('/')}>Go to Home</a></p>
