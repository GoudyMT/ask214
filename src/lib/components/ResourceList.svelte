<script lang="ts">
	import { groupByDisplayCategory, DISPLAY_CATEGORY_LABEL, type Resource } from '$lib/resources';

	let { resources }: { resources: readonly Resource[] } = $props();

	// The Map preserves insertion order, so categories render in the curated data order.
	const groups = $derived([...groupByDisplayCategory(resources)]);
</script>

<div class="resource-list">
	{#each groups as [category, items] (category)}
		<section class="resource-group" aria-labelledby="rg-{category}">
			<h2 id="rg-{category}" class="resource-group__head">{DISPLAY_CATEGORY_LABEL[category]}</h2>
			{#if category === 'claims-vso'}
				<!-- The 38 CFR boundary line, in the app danger register. -->
				<p class="resource-boundary">
					Ask 214 doesn't help with VA claims - these are official, VA-accredited channels for
					filing. Accredited VSO help on your claim is always free.
				</p>
			{/if}
			<ul class="resource-rows">
				{#each items as r (r.id)}
					<li class="resource-row">
						<a
							class="resource-row__title"
							href={r.url}
							target="_blank"
							rel="noopener noreferrer external"
						>
							{r.title}<span class="resource-row__ext" aria-hidden="true"> &#8599;</span><span
								class="visually-hidden"
							>
								(opens in a new tab)</span
							>
						</a>
						<p class="resource-row__desc">{r.description}</p>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.resource-group {
		margin-bottom: var(--space-l);
	}

	.resource-group__head {
		font-size: var(--font-size-l);
		margin: 0 0 var(--space-s);
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--color-border);
	}

	.resource-boundary {
		border-left: 3px solid var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 8%, transparent);
		border-radius: var(--radius-s);
		padding: var(--space-s) var(--space-m);
		margin: 0 0 var(--space-s);
		font-size: var(--font-size-s);
		color: var(--color-fg);
	}

	.resource-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* Dense list row: title link + one-line description, divided from the next row. */
	.resource-row {
		padding: var(--space-s) 0;
		border-bottom: 1px solid var(--color-border);
	}

	.resource-row__title {
		font-weight: 500;
		text-decoration: none;
	}

	.resource-row__title:hover {
		text-decoration: underline;
	}

	.resource-row__ext {
		font-size: var(--font-size-s);
	}

	.resource-row__desc {
		margin: 2px 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
