<script lang="ts">
	import { onMount, tick } from 'svelte';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import CompareTable from '$lib/skillbridge-finder/ui/CompareTable.svelte';
	import CompareTray from '$lib/skillbridge-finder/ui/CompareTray.svelte';
	import List from '$lib/skillbridge-finder/ui/List.svelte';
	import ProgramCard from '$lib/skillbridge-finder/ui/ProgramCard.svelte';
	import {
		createFinderSession,
		type FinderSession
	} from '$lib/skillbridge-finder/ui/session.svelte';
	import Setup from '$lib/skillbridge-finder/ui/Setup.svelte';
	import { parsePlaceText } from '$lib/skillbridge-finder/ui/place-text';
	import { isSetUp, withSetupChoices } from '$lib/skillbridge-finder/ui/setup-state';
	import type { Listing } from '$lib/skillbridge-finder/contract/listing';
	import type { SavedStatus } from '$lib/skillbridge-finder/state/saved-status';
	import type { FinderFilters, FinderSetup } from '$lib/skillbridge-finder/state/types';

	const app = getProfileApp();

	const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
	const SAVE_FAILED = 'Could not save your choices right now. Try again.';
	const COMPARE_FAILED = 'Could not save that change. Try again.';
	// One pick has nothing to be compared with, so the tray waits for a second.
	const MIN_PICKS_TO_COMPARE = 2;
	const finder = $derived(app.finder);

	let headingEl = $state<HTMLElement>();
	let unlocking = $state(false);
	let unlockError = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	// Settings links here with #setup; the page reads it again when it changes under an open page.
	let changing = $state(false);
	let session = $state.raw<FinderSession | null>(null);
	// The table takes the list's place on the page; the list stays mounted underneath so its tab, paging and place
	// in the scroll are as the person left them.
	let comparing = $state(false);
	let compareError = $state<string | null>(null);
	let listScrollY = 0;

	// The finder's own lock: a Lock relocks every store at once, so this is also the profile's.
	const lockedView = $derived(finder?.locked ?? false);
	const unreadable = $derived(finder?.failed ?? false);
	// The place the profile names, offered on the setup screen; null while the profile is locked or names none.
	const destination = $derived.by(() => {
		const saved = app.store?.destination;
		return saved ? parsePlaceText(saved) : null;
	});
	const showSetup = $derived(
		app.status === 'ready' && !!finder?.ready && (!isSetUp(finder.setup) || changing)
	);

	$effect(() => {
		void lockedView;
		unlockError = null;
	});

	// The picks as the table shows them, read from the held week or, for a saved program the week dropped, from the
	// facts saved with it. A pick known to neither has nothing to show.
	// A function read inside the table's own block, not a page-level derived: a derived nobody reads any more keeps its
	// last value, and after a Lock that value would be the decrypted picks.
	function comparePicks() {
		if (!comparing || !session || !finder) return [];
		const held = new Map(session.listings.map((l) => [l.i, l]));
		const kept = session;
		return finder.compare.flatMap((id) => {
			const listing = held.get(id) ?? finder.saved.find((s) => s.id === id)?.facts;
			return listing ? [{ listing, unlisted: kept.savedStatus(id).kind === 'missing' }] : [];
		});
	}

	async function openCompare(): Promise<void> {
		listScrollY = window.scrollY;
		compareError = null;
		comparing = true;
		await tick();
		window.scrollTo(0, 0);
		document.getElementById('compare-heading')?.focus({ preventScroll: true });
	}

	async function closeCompare(): Promise<void> {
		comparing = false;
		await tick();
		headingEl?.focus({ preventScroll: true });
		window.scrollTo(0, listScrollY);
	}

	// A Lock empties the picks and the week with it, so the table must not outlive it; picks taken away down to none
	// leave nothing to compare.
	$effect(() => {
		if (!comparing) return;
		if (lockedView) comparing = false;
		else if (finder?.ready && finder.compare.length === 0) void closeCompare();
	});

	/** A write to the record; one that fails reads the record again and says so. */
	async function writeCompare(run: () => Promise<void>): Promise<void> {
		compareError = null;
		try {
			await run();
		} catch {
			await finder?.refresh().catch(() => undefined);
			compareError = COMPARE_FAILED;
		}
	}

	// One session for the visit, over the stores the layout provides once they exist.
	$effect(() => {
		const f = app.finder;
		const p = app.finderPack;
		if (!f || !p) return;
		const made = createFinderSession({ finder: f, pack: p });
		session = made;
		return () => {
			made.destroy();
			session = null;
		};
	});

	// The week is opened and refreshed once the person is through setup and everything is open; a lock empties the
	// session, and the Unlock that follows opens the stores again and lands here. A pack that failed to load starts it
	// too: the session is what clears an unreadable week and downloads it again.
	const listOpen = $derived(
		!!session &&
			!!finder?.ready &&
			(!!app.finderPack?.ready || !!app.finderPack?.failed) &&
			isSetUp(finder.setup) &&
			!changing
	);
	$effect(() => {
		if (listOpen) void session?.start();
	});

	onMount(() => {
		const sync = () => (changing = location.hash === '#setup');
		sync();
		window.addEventListener('hashchange', sync);
		return () => window.removeEventListener('hashchange', sync);
	});

	async function unlock(): Promise<void> {
		// This device's data was replaced from a backup while the page was locked: reading it again would open stale
		// data, so the page starts over on the restored data.
		if (app.reloadOnUnlock) {
			location.reload();
			return;
		}
		const store = app.store;
		if (!store) return;
		unlockError = null;
		unlocking = true;
		try {
			await store.load();
			// The other stores relock with the profile but are not part of its load: each is read again here, and one
			// that fails says so in its own place rather than blocking the unlock.
			await Promise.allSettled([
				app.timeline?.load(),
				app.calendar?.load(),
				app.finder?.load(),
				app.finderPack?.load()
			]);
		} catch {
			unlockError = UNLOCK_FAILED;
			return;
		} finally {
			unlocking = false;
		}
		await tick();
		if (document.activeElement === document.body) headingEl?.focus();
	}

	/** Writes the setup screen's answers; a failed write keeps the screen as typed and says so. */
	async function saveSetup(setup: FinderSetup, choices: FinderFilters): Promise<void> {
		const store = app.finder;
		if (!store) return;
		saveError = null;
		try {
			// Filters first: a first setup closes the moment the record says it is done, so anything written after that
			// would land on a list already showing, and a failure would be said on a screen that is gone.
			await store.setFilters((current) => withSetupChoices(current, choices));
			await store.setSetup(setup);
		} catch {
			// The record is read again, so what shows is what is saved (another tab may have written meanwhile).
			await store.refresh().catch(() => undefined);
			saveError = SAVE_FAILED;
			return;
		}
		changing = false;
		// The setup address is spent: a reload must not open the setup again.
		if (location.hash === '#setup') {
			history.replaceState(history.state, '', location.pathname + location.search);
		}
		await tick();
		headingEl?.focus();
	}
</script>

<svelte:head>
	<title>SkillBridge - Ask 214</title>
</svelte:head>

{#snippet program(args: {
	listing: Listing;
	miles?: number | undefined;
	isNew: boolean;
	status?: SavedStatus;
})}
	{#if session && finder}
		<ProgramCard
			listing={args.listing}
			miles={args.miles}
			isNew={args.isNew}
			status={args.status}
			{session}
			{finder}
		/>
	{/if}
{/snippet}

<!-- A browser's page translation sends this screen's text to a translation service, and the place is the person's own. -->
<div translate="no">
	{#if !comparing}
		<h1 bind:this={headingEl} tabindex="-1">SkillBridge</h1>
	{/if}

	{#if app.finderFailed}
		<div class="finder-note">
			<p role="alert">The SkillBridge finder couldn't be loaded. Reload to try again.</p>
			<button type="button" onclick={() => location.reload()}>Reload</button>
		</div>
	{:else if app.status === 'ready' && finder}
		{#if lockedView}
			<LockedPanel onunlock={() => void unlock()} busy={unlocking} error={unlockError} />
		{:else if unreadable}
			<div class="finder-note">
				<p role="alert">Your saved SkillBridge choices couldn't be read. Reload to try again.</p>
				<button type="button" onclick={() => location.reload()}>Reload</button>
			</div>
		{:else if showSetup}
			<Setup
				initial={{ setup: finder.setup, filters: finder.filters }}
				{destination}
				loadZips={() => session?.ensureZips() ?? Promise.resolve(undefined)}
				onsave={saveSetup}
				error={saveError}
			/>
		{:else if finder.ready && session}
			{#if comparing}
				{@const picks = comparePicks()}
				{#if compareError}<p class="finder-problem" role="alert">{compareError}</p>{/if}
				<CompareTable
					listings={picks.map((p) => p.listing)}
					unlisted={new Set(picks.filter((p) => p.unlisted).map((p) => p.listing.i))}
					onremove={(id) => void writeCompare(() => finder.removeCompare(id))}
					onback={() => void closeCompare()}
					onadd={() => void closeCompare()}
					onclear={() => void writeCompare(() => finder.clearCompare())}
				/>
			{/if}
			<div hidden={comparing}>
				<List {session} {finder} card={program} />
			</div>
			{#if !comparing && finder.compare.length >= MIN_PICKS_TO_COMPARE}
				<!-- The tray is fixed over the bottom of the page: this space keeps the last card clear of it. -->
				<div class="tray-space" aria-hidden="true"></div>
				<CompareTray count={finder.compare.length} oncompare={() => void openCompare()} />
			{/if}
		{/if}
	{/if}
</div>

<style>
	h1 {
		margin: 0 0 var(--space-s);
	}

	h1:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.finder-note {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-s);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-danger);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
	}

	.tray-space {
		height: 72px;
	}

	.finder-problem {
		margin: 0 0 var(--space-s);
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.finder-note p {
		margin: 0;
	}

	.finder-note button {
		min-height: 44px;
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font: inherit;
		cursor: pointer;
	}
</style>
