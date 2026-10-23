<script lang="ts">
	import { BRANCHES, type Listing } from '../contract/listing';
	import { placement } from '../state/distance';
	import { STATE_NAMES } from '../search/state-names';
	import { MAX_COMPARE } from '../state/types';

	type Props = {
		listings: Listing[];
		onremove: (id: number) => void;
		onback: () => void;
		onadd: () => void;
		onclear: () => void;
		/** Ids of programs the weekly files no longer list; their saved facts still show. */
		unlisted?: ReadonlySet<number>;
	};
	let { listings, onremove, onback, onadd, onclear, unlisted }: Props = $props();

	const NOT_AFFILIATED =
		'Listings from DoD SkillBridge (skillbridge.mil). Ask 214 is independent, not a Department of Defense or Department of War site, and not endorsed by either.';

	function where(l: Listing): string {
		const p = placement(l);
		if (p.kind === 'remote') return 'Online';
		if (p.kind === 'multi') return `Offered in ${p.states} states`;
		if (l.s !== undefined) {
			return l.c ? `${l.c}, ${l.s}` : `${STATE_NAMES[l.s]}, no city listed`;
		}
		return 'Location not listed';
	}

	const length = (l: Listing) => (l.d ? `${l.d} days` : 'Length not listed');

	const branches = (l: Listing) =>
		l.b.length === 0
			? 'Any branch'
			: l.b.length === BRANCHES.length
				? 'All branches'
				: l.b.join(', ');

	// "Not Selected" is the site's own industry name for a listing that picked none.
	const field = (l: Listing) => (l.ind.length === 0 ? 'Not Selected' : l.ind.join('; '));

	const ROWS: { label: string; value: (l: Listing) => string }[] = [
		{ label: 'Where', value: where },
		{ label: 'Length', value: length },
		{ label: 'Listed for', value: branches },
		{ label: 'Field', value: field }
	];
</script>

<div class="compare">
	<button class="compare__text-button compare__back" type="button" onclick={onback}>
		Back to programs
	</button>
	<!-- tabindex -1: the page hands focus here when the table opens. -->
	<h1 id="compare-heading" tabindex="-1">Compare programs</h1>

	<!-- A scroll box a keyboard can reach: arrow keys scroll it once it has focus. Not a widget, so the compiler's rule
	     against a tab stop on a non-interactive role does not fit; this is the scrollable region pattern. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="compare__scroll" role="region" aria-labelledby="compare-heading" tabindex="0">
		<table>
			<thead>
				<tr>
					<td class="compare__corner"></td>
					{#each listings as l (l.i)}
						<th scope="col">
							{#if unlisted?.has(l.i)}<span class="compare__gone">No longer listed</span>{/if}
							<span class="compare__org">{l.n}</span>
							<span class="compare__program">{l.p}</span>
							<button
								class="compare__text-button"
								type="button"
								aria-label={`Remove ${l.n}`}
								onclick={() => onremove(l.i)}>Remove</button
							>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each ROWS as r (r.label)}
					<tr>
						<th scope="row">{r.label}</th>
						{#each listings as l (l.i)}
							<td>{r.value(l)}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="compare__actions">
		{#if listings.length < MAX_COMPARE}
			<button class="compare__add" type="button" onclick={onadd}>Add another</button>
		{/if}
		<button class="compare__text-button" type="button" onclick={onclear}>Clear all</button>
	</div>
	<p class="compare__note">{NOT_AFFILIATED}</p>
</div>

<style>
	h1 {
		margin: 0 0 var(--space-m);
	}

	h1:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* A link-looking button: the page's text actions are buttons because none of them navigates by address. */
	.compare__text-button {
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.compare__scroll {
		overflow-x: auto;
		max-width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
	}

	table {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		font-size: var(--font-size-s);
	}

	th,
	td {
		min-width: 10rem;
		padding: var(--space-s) var(--space-m);
		text-align: left;
		vertical-align: top;
		overflow-wrap: anywhere;
		border-bottom: 1px solid var(--color-border);
	}

	tbody tr:last-child > th,
	tbody tr:last-child > td {
		border-bottom: none;
	}

	/* Fixed on the left while the programs scroll past, and opaque so they do not show through. */
	th[scope='row'],
	.compare__corner {
		position: sticky;
		left: 0;
		z-index: 1;
		/* A width the program columns cannot squeeze, and breaks only between words: "Where" one letter to a line is
		   unreadable. */
		min-width: 4.5rem;
		width: 4.5rem;
		padding-inline: var(--space-s);
		overflow-wrap: normal;
		background: var(--color-surface);
		border-right: 1px solid var(--color-border);
	}

	thead th {
		font-weight: 400;
	}

	/* The card's own "No longer listed" tag. */
	.compare__gone {
		display: inline-block;
		margin-bottom: var(--space-xs);
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 45%, transparent);
		border-radius: var(--radius-s);
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: color-mix(in srgb, var(--color-danger) 80%, var(--color-fg));
		line-height: 1.4;
		white-space: nowrap;
	}

	.compare__org {
		display: block;
		font-weight: 600;
	}

	.compare__program {
		display: block;
	}

	.compare__add {
		min-height: 44px;
		padding: 0 var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.compare__add:hover {
		background: var(--color-accent-muted);
	}

	.compare__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-m);
	}

	.compare__note {
		margin: var(--space-m) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	@media (forced-colors: active) {
		.compare__add {
			border: 1px solid ButtonText;
		}
	}
</style>
