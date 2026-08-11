<script lang="ts">
	import ResourceList from '$lib/components/ResourceList.svelte';
	import { RESOURCES } from '$lib/resources';
</script>

<svelte:head>
	<title>Resources - Ask 214</title>
	<meta
		name="description"
		content="Vetted links to official benefits, employment, and transition resources for service members and veterans."
	/>
</svelte:head>

<h1>Resources</h1>
<p class="resources-lede">
	Vetted links for benefits, employment, education, and transition. Claims and benefits links go
	only to VA.gov and VA-accredited veterans service organizations; the rest are official government
	programs and trusted nonprofits.
</p>

<ResourceList resources={RESOURCES} />

<p class="resources-disclaimer">
	Ask 214 is independent and not affiliated with the VA, the DoD, or any branch of the US military.
	We do not provide legal, financial, or medical advice, or help with VA claims. For official
	guidance, contact a VA-accredited VSO or visit va.gov.
</p>

<style>
	.resources-lede {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		margin: 0 0 var(--space-l);
	}

	.resources-disclaimer {
		margin: var(--space-l) 0 0;
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
</style>
