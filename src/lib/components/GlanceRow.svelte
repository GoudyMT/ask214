<script lang="ts">
	import { resolve } from '$app/paths';
	import type { RouteId } from '$app/types';
	import type { HomeRow } from '$lib/timeline/home-glance';

	let { row, to }: { row: HomeRow; to: RouteId } = $props();
</script>

<!-- One tool's row on Home: the whole row is one link, so it is one tap target, and its text is the link's name. -->
<a class="glance" href={resolve(to)}>
	<span class="glance__text">
		<!-- The separators are text expressions: whitespace written at the edge of an element's content is trimmed. -->
		<span class="glance__name"
			>{row.name}{#if row.count}<span class="glance__count">{` - ${row.count}`}</span>{/if}</span
		>
		<span class="glance__detail"
			>{#if row.status}<span class="glance__status" class:glance__status--hot={row.status.hot}
					>{row.status.word}</span
				>{/if}{row.status ? ` - ${row.detail}` : row.detail}</span
		>
	</span>
	<span class="glance__chev" aria-hidden="true"></span>
</a>

<style>
	/* A plain content row, not a card: Ask stays the only loud thing on Home. */
	.glance {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		min-height: 56px;
		padding: var(--space-s) 0;
		color: var(--color-fg);
		text-decoration: none;
		font-size: var(--font-size-s);
		border-bottom: 1px solid var(--color-border);
	}
	.glance:hover .glance__name {
		text-decoration: underline;
	}
	.glance__text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.glance__name {
		font-weight: 600;
		font-size: var(--font-size-base);
	}
	.glance__count {
		font-weight: 400;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.glance__detail {
		color: var(--color-fg-muted);
	}
	.glance__status {
		font-weight: 600;
		color: var(--color-fg);
	}
	.glance__status--hot {
		color: var(--color-danger);
	}
	/* A chevron drawn with two borders, so it takes the text colour in every theme and in forced colours. */
	.glance__chev {
		flex: none;
		width: 10px;
		height: 10px;
		margin-right: var(--space-xs);
		border-top: 2px solid currentColor;
		border-right: 2px solid currentColor;
		color: var(--color-fg-muted);
		transform: rotate(45deg);
	}
</style>
