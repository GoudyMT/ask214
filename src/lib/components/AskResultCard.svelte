<script lang="ts">
	import type { ResultCard } from '$lib/corpus';

	let {
		card,
		variant = 'compact',
		onReadSource
	}: { card: ResultCard; variant?: 'lead' | 'compact'; onReadSource?: () => void } = $props();

	// B passes the full chunk text through as the excerpt (the display truncation it deliberately left to
	// C). The lead card shows a fuller excerpt; a collapsed "similar" card shows a one-liner.
	const MAX_WORDS = { lead: 120, compact: 24 } as const;
	const excerpt = $derived(truncateWords(card.excerpt, MAX_WORDS[variant]));

	// Source descriptor: section and/or page when present (e.g. "How to submit - p. 12").
	const meta = $derived(
		[card.section, card.page !== undefined ? `p. ${card.page}` : undefined]
			.filter((part): part is string => part !== undefined)
			.join(' - ')
	);

	function truncateWords(text: string, maxWords: number): string {
		const words = text.trim().split(/\s+/);
		return words.length <= maxWords ? text.trim() : words.slice(0, maxWords).join(' ') + '...';
	}
</script>

<article class="ask-card" class:ask-card--lead={variant === 'lead'}>
	{#if variant === 'lead'}<p class="ask-card__top-match">Top match</p>{/if}
	<div class="ask-card__src">
		<span class="ask-card__title">{card.sourceTitle}</span>
		{#if meta}<span class="ask-card__meta">{meta}</span>{/if}
	</div>
	<p class="ask-card__excerpt">{excerpt}</p>
	<div class="ask-card__actions">
		{#if onReadSource}
			<button class="ask-card__read" type="button" onclick={onReadSource}>Read more</button>
		{/if}
		<!-- card.url is an external public-source citation (https), not internal SvelteKit nav; resolve() does not apply. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="ask-card__link" href={card.url} target="_blank" rel="noopener noreferrer"
			>View on the official site</a
		>
	</div>
</article>

<style>
	.ask-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-m);
		margin-bottom: var(--space-s);
	}
	.ask-card--lead {
		border-left: 4px solid var(--color-accent);
	}
	.ask-card__top-match {
		margin: 0 0 var(--space-xs);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-accent);
	}
	.ask-card__src {
		display: flex;
		align-items: baseline;
		gap: var(--space-s);
		flex-wrap: wrap;
	}
	.ask-card__title {
		font-weight: 600;
		font-size: var(--font-size-base);
	}
	.ask-card--lead .ask-card__title {
		font-size: var(--font-size-l);
	}
	.ask-card__meta {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.ask-card__excerpt {
		margin: var(--space-s) 0;
		font-size: var(--font-size-s);
	}
	.ask-card--lead .ask-card__excerpt {
		font-size: var(--font-size-base);
	}
	.ask-card__link {
		font-size: var(--font-size-s);
		text-decoration: none;
	}
	.ask-card__link::after {
		content: ' >';
		opacity: 0.6;
	}
	.ask-card__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-s);
	}
	.ask-card__read {
		background: none;
		border: 1px solid var(--color-accent);
		color: var(--color-accent);
		border-radius: var(--radius-s);
		padding: 6px var(--space-m);
		font: inherit;
		font-size: var(--font-size-s);
		font-weight: 600;
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.ask-card__read:hover {
		background: var(--color-accent);
		color: var(--color-bg);
	}
	.ask-card__read:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.ask-card__read:active {
		transform: translateY(1px);
	}
</style>
