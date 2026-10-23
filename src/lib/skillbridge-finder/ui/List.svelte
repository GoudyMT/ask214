<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Listing } from '../contract/listing';
	import { STATE_NAMES } from '../search/state-names';
	import { countInState } from '../state/match';
	import type { SavedStatus } from '../state/saved-status';
	import type { FinderStore } from '../state/store.svelte';
	import { formatTimelineDate } from '../../timeline/format-date';
	import { CREDIT_LINE, DIB_LINE, NOT_AFFILIATED } from './copy';
	import FilterSheet from './FilterSheet.svelte';
	import { chipsOf, clearAllChips, removeChip, widerRadius, type Chip } from './list-model';
	import SearchBox from './SearchBox.svelte';
	import type { FinderSession } from './session.svelte';

	type CardArgs = {
		listing: Listing;
		miles?: number | undefined;
		isNew: boolean;
		/** Set for a saved program: whether the weekly files still list it. */
		status?: SavedStatus;
	};
	type Props = { session: FinderSession; finder: FinderStore; card: Snippet<[CardArgs]> };
	let { session, finder, card }: Props = $props();

	const PAGE_SIZE = 20;
	// Past this many days since the pull, the listings are called old.
	const STALE_DAYS = 14;
	// Past this many missed weekly updates, "new" no longer means this week's.
	const MAX_MISSED_WEEKS = 4;
	const SAVE_FAILED = 'Could not save that change. Try again.';

	let tab = $state<'programs' | 'saved'>('programs');
	let shown = $state(PAGE_SIZE);
	let declinedAll = $state(false);
	let downloadingAll = $state(false);
	let problem = $state<string | null>(null);
	// A download can fail with the phone online (the data host is down); the offline line is only true when it is not.
	let online = $state(navigator.onLine);
	$effect(() => {
		const update = () => (online = navigator.onLine);
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});
	let sheet = $state<FilterSheet>();

	const setup = $derived(finder.setup);
	const filters = $derived(finder.filters);
	const chips = $derived(chipsOf(setup, filters));
	const rows = $derived(session.results);
	const query = $derived(session.query.trim());
	const newCount = $derived(
		session.missedWeeks > MAX_MISSED_WEEKS
			? 0
			: rows.filter((r) => session.isNewId(r.listing.i)).length
	);
	const saved = $derived([...finder.saved].reverse());
	const pullDate = $derived(session.pullDate);
	const stateName = $derived(setup.place?.kind === 'state' ? STATE_NAMES[setup.place.state] : null);

	const offer = $derived(
		query !== '' && session.needsSearchAll && !declinedAll
			? {
					bytes: session.searchAllBytes,
					busy: downloadingAll,
					onaccept: () => void searchEveryRegion(),
					ondecline: () => (declinedAll = true)
				}
			: null
	);

	// A new search or filter starts the list again from its first 20.
	const viewKey = $derived(JSON.stringify([session.query, filters, setup]));
	$effect(() => {
		void viewKey;
		shown = PAGE_SIZE;
	});

	// "Look farther" only from a ZIP with a reach smaller than the widest one offered.
	const farther = $derived(setup.place?.kind === 'zip' ? widerRadius(setup.radius) : null);
	const noMatch = $derived(session.listings.length > 0 && rows.length === 0);
	const noChoices = $derived<Chip[]>(
		query === '' ? chips : [...chips, { id: 'query', label: `"${query}"` }]
	);

	/** A write to the record; one that fails reads the record again and says so. */
	async function write(run: () => Promise<void>): Promise<void> {
		problem = null;
		try {
			await run();
		} catch {
			await finder.refresh().catch(() => undefined);
			problem = SAVE_FAILED;
		}
	}

	function remove(id: string): void {
		if (id === 'query') {
			session.query = '';
		} else if (id === 'place') {
			void write(() => finder.setSetup((cur) => removeChip('place', cur, {}).setup));
		} else {
			void write(() => finder.setFilters((cur) => removeChip(id, {}, cur).filters));
		}
	}

	function clearAll(): void {
		void write(async () => {
			await finder.setSetup((cur) => clearAllChips(cur).setup);
			await finder.setFilters({});
		});
	}

	async function lookFarther(): Promise<void> {
		await write(() => finder.setSetup((cur) => ({ ...cur, radius: 100 })));
		// A wider reach may need files the person has not downloaded.
		await session.start();
	}

	async function searchEveryRegion(): Promise<void> {
		downloadingAll = true;
		try {
			await session.searchAll();
		} finally {
			downloadingAll = false;
		}
	}

	function onTabKey(e: KeyboardEvent): void {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		tab = tab === 'programs' ? 'saved' : 'programs';
		document.getElementById(`finder-tab-${tab}`)?.focus();
	}
</script>

{#snippet chipButton(c: Chip)}
	<button
		type="button"
		class="list__chip"
		aria-label="Remove {c.label}"
		onclick={() => remove(c.id)}>{c.label} <span aria-hidden="true">x</span></button
	>
{/snippet}

{#if pullDate}
	{#if session.staleDays > STALE_DAYS}
		<p class="list__stale">
			These listings are from {formatTimelineDate(pullDate)}. New ones load the next time you are
			online.
		</p>
	{:else}
		<p class="list__date">Listings from {formatTimelineDate(pullDate)}</p>
	{/if}
{/if}
<p class="list__muted">{NOT_AFFILIATED}</p>

<div
	class="list__tabs"
	role="tablist"
	aria-label="Programs or saved"
	tabindex="-1"
	onkeydown={onTabKey}
>
	<button
		id="finder-tab-programs"
		type="button"
		role="tab"
		class="list__tab"
		aria-selected={tab === 'programs'}
		aria-controls="finder-panel"
		tabindex={tab === 'programs' ? 0 : -1}
		onclick={() => (tab = 'programs')}>Programs</button
	>
	<button
		id="finder-tab-saved"
		type="button"
		role="tab"
		class="list__tab"
		aria-selected={tab === 'saved'}
		aria-controls="finder-panel"
		tabindex={tab === 'saved' ? 0 : -1}
		onclick={() => (tab = 'saved')}>Saved ({finder.saved.length})</button
	>
</div>

<div id="finder-panel" role="tabpanel" aria-labelledby="finder-tab-{tab}">
	{#if problem}<p class="list__problem" role="alert">{problem}</p>{/if}

	{#if tab === 'saved'}
		{#if saved.length === 0}
			<p class="list__muted">Nothing saved yet. Save a program to keep it here.</p>
		{:else}
			{#each saved as item (item.id)}
				{@render card({ listing: item.facts, isNew: false, status: session.savedStatus(item.id) })}
			{/each}
		{/if}
	{:else}
		<SearchBox bind:value={session.query} {offer} />

		<div class="list__chips">
			{#each chips as c (c.id)}{@render chipButton(c)}{/each}
			{#if chips.length >= 2}
				<button type="button" class="list__link" onclick={clearAll}>Clear all</button>
			{/if}
			<button type="button" class="list__filters" onclick={() => sheet?.show()}
				>Filters{chips.length > 0 ? ` (${chips.length})` : ''}</button
			>
		</div>

		{#if session.listings.length === 0}
			{#if session.status === 'loading'}
				<p class="list__muted">Loading listings...</p>
			{:else if session.status === 'offline' && !online}
				<p class="list__muted">You are offline and no listings are downloaded yet.</p>
			{:else if session.status === 'failed' || session.status === 'offline'}
				<p class="list__muted" role="alert">Listings couldn't be downloaded right now.</p>
				<button type="button" class="list__more" onclick={() => void session.start()}
					>Try again</button
				>
			{:else}
				<p class="list__muted">No listings are available for this area right now.</p>
			{/if}
		{:else}
			<p class="list__count">
				<strong>{rows.length} {rows.length === 1 ? 'program' : 'programs'}</strong>
				{#if newCount > 0}
					- {newCount} new
					<button type="button" class="list__link" onclick={() => void session.markAllSeen()}
						>Mark all seen</button
					>
				{/if}
			</p>
			{#if setup.place?.kind === 'zip'}
				<p class="list__muted">Nearest first. Online, many-state and unplaced programs follow.</p>
			{:else if setup.place?.kind === 'state' && stateName}
				<p class="list__muted">
					{countInState(
						rows.map((r) => r.listing),
						setup.place.state
					)} in {stateName}. Distance needs a ZIP code.
				</p>
			{/if}

			{#if noMatch}
				<section class="list__none" aria-labelledby="finder-none-title">
					<h2 id="finder-none-title">No programs match all of these</h2>
					<p>Remove one to see more:</p>
					<div class="list__chips">
						{#each noChoices as c (c.id)}{@render chipButton(c)}{/each}
					</div>
					{#if farther !== null}
						<p>
							Or look farther:
							<button type="button" class="list__chip" onclick={() => void lookFarther()}
								>Within {farther} mi</button
							>
						</p>
					{/if}
				</section>
			{:else}
				{#each rows.slice(0, shown) as row (row.listing.i)}
					{@render card({
						listing: row.listing,
						miles: row.miles,
						isNew: session.isNewId(row.listing.i)
					})}
				{/each}
				{#if rows.length > shown}
					<button type="button" class="list__more" onclick={() => (shown += PAGE_SIZE)}
						>Show {Math.min(PAGE_SIZE, rows.length - shown)} more</button
					>
				{/if}
			{/if}
		{/if}

		<p class="list__note"><span class="list__dib">DIB</span> {DIB_LINE}</p>
		<p class="list__note">{CREDIT_LINE}</p>
	{/if}
</div>

<!-- Closing the modal dialog gives focus back to the button that opened it, as the browser does for any modal. -->
<FilterSheet bind:this={sheet} {session} {finder} />

<style>
	.list__date {
		margin: 0 0 var(--space-xs);
		font-weight: 600;
		font-size: var(--font-size-s);
	}

	.list__stale {
		margin: 0 0 var(--space-xs);
		color: var(--color-danger);
		font-weight: 600;
		font-size: var(--font-size-s);
	}

	.list__muted {
		margin: 0 0 var(--space-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.list__tabs {
		display: flex;
		gap: var(--space-m);
		margin: var(--space-m) 0;
		border-bottom: 1px solid var(--color-border);
	}

	.list__tab {
		min-height: 44px;
		padding: 0 var(--space-xs);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-fg-muted);
		font: inherit;
		cursor: pointer;
	}

	.list__tab[aria-selected='true'] {
		border-bottom-color: var(--color-accent);
		color: var(--color-fg);
	}

	.list__chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin: var(--space-s) 0;
	}

	.list__chip,
	.list__filters {
		min-height: 44px;
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-accent);
		border-radius: 999px;
		color: var(--color-fg);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}

	.list__filters {
		color: var(--color-accent);
	}

	.list__link {
		min-height: 44px;
		padding: 0 var(--space-xs);
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.list__count {
		margin: var(--space-s) 0 var(--space-xs);
		font-size: var(--font-size-s);
	}

	.list__none {
		margin: var(--space-s) 0;
		padding: var(--space-s) var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-m);
	}

	.list__none h2 {
		margin: 0 0 var(--space-s);
		font-size: var(--font-size-l);
	}

	.list__none p {
		margin: 0 0 var(--space-xs);
	}

	.list__more {
		display: block;
		width: 100%;
		min-height: 44px;
		margin: var(--space-s) 0;
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		color: var(--color-accent);
		font: inherit;
		cursor: pointer;
	}

	.list__problem {
		margin: 0 0 var(--space-s);
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.list__note {
		margin: var(--space-m) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* The career purple of the card's DIB tag. */
	.list__dib {
		display: inline-block;
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, var(--color-category-career) 45%, transparent);
		border-radius: var(--radius-s);
		background: color-mix(in srgb, var(--color-category-career) 12%, transparent);
		color: var(--color-category-career);
	}

	@media (forced-colors: active) {
		.list__tab[aria-selected='true'] {
			outline: 2px solid Highlight;
		}
	}
</style>
