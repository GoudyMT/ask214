<script lang="ts">
	import type { SourcesIndex } from '$lib/sources/types';

	let { index }: { index: SourcesIndex } = $props();
</script>

<div class="source-list">
	<section aria-labelledby="src-agency">
		<h3 id="src-agency" class="src-group__head">Official agency pages ({index.agency.length})</h3>
		<ul class="src-rows">
			{#each index.agency as source (source.url)}
				<li class="src-row">
					<a
						class="src-row__title"
						href={source.url}
						target="_blank"
						rel="noopener noreferrer external"
					>
						{source.title}<span class="src-row__ext" aria-hidden="true"> &#8599;</span><span
							class="visually-hidden"
						>
							(opens in a new tab)</span
						>
					</a>
					<span class="src-tag">{source.publisher}</span>
				</li>
			{/each}
		</ul>
	</section>

	<section aria-labelledby="src-tap">
		<h3 id="src-tap" class="src-group__head">
			Transition (TAP) curriculum guides ({index.tapGuides.length})
		</h3>
		<!-- Every guide lives in one shared library, so we surface a single link + the titles, rather than
		     21 identical links. -->
		<p class="tap-note">
			These federal transition-curriculum guides are all published in one place. Open the official
			library to read any of them:
		</p>
		<p>
			<a
				class="tap-open"
				href={index.tapLibraryUrl}
				target="_blank"
				rel="noopener noreferrer external"
			>
				Official TAP documents library<span class="src-row__ext" aria-hidden="true">
					&#8599;</span
				><span class="visually-hidden"> (opens in a new tab)</span>
			</a>
		</p>
		<ul class="tap-titles">
			{#each index.tapGuides as guide (guide.title)}
				<li><span class="src-tag">{guide.publisher}</span><span>{guide.title}</span></li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.src-group__head {
		font-size: var(--font-size-l);
		margin: var(--space-l) 0 var(--space-s);
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--color-border);
	}

	.src-rows,
	.tap-titles {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* Dense row: title link + a publisher tag, divided from the next row (mirrors ResourceList). */
	.src-row {
		padding: var(--space-s) 0;
		border-bottom: 1px solid var(--color-border);
		display: flex;
		gap: var(--space-s);
		align-items: baseline;
		justify-content: space-between;
	}

	.src-row__title {
		font-weight: 500;
		text-decoration: none;
	}

	.src-row__title:hover {
		text-decoration: underline;
	}

	.src-row__ext {
		font-size: var(--font-size-s);
	}

	/* Small muted provenance pill; fg-muted meets AA on the page background (same pair as ResourceList). */
	.src-tag {
		flex: none;
		font-size: 12px;
		color: var(--color-fg-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		padding: 1px var(--space-xs);
		white-space: nowrap;
	}

	.tap-note {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-s);
	}

	.tap-open {
		font-weight: 500;
	}

	/* TAP guides are titles-only (unlinked) - the one library link above reaches every one of them. */
	.tap-titles li {
		display: flex;
		gap: var(--space-xs);
		align-items: baseline;
		padding: var(--space-xs) 0;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-fg);
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
