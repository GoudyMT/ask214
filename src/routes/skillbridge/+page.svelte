<script lang="ts">
	import { onMount, tick } from 'svelte';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import List from '$lib/skillbridge-finder/ui/List.svelte';
	import ProgramCard from '$lib/skillbridge-finder/ui/ProgramCard.svelte';
	import {
		createFinderSession,
		type FinderSession
	} from '$lib/skillbridge-finder/ui/session.svelte';
	import Setup from '$lib/skillbridge-finder/ui/Setup.svelte';
	import { isSetUp, withSetupChoices } from '$lib/skillbridge-finder/ui/setup-state';
	import type { Listing } from '$lib/skillbridge-finder/contract/listing';
	import type { SavedStatus } from '$lib/skillbridge-finder/state/saved-status';
	import type { FinderFilters, FinderSetup } from '$lib/skillbridge-finder/state/types';

	const app = getProfileApp();

	const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
	const SAVE_FAILED = 'Could not save your choices right now. Try again.';
	const finder = $derived(app.finder);

	let headingEl: HTMLElement | undefined;
	let unlocking = $state(false);
	let unlockError = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	// Settings links here with #setup; the page reads it again when it changes under an open page.
	let changing = $state(false);
	let session = $state.raw<FinderSession | null>(null);

	// The finder's own lock: a Lock relocks every store at once, so this is also the profile's.
	const lockedView = $derived(finder?.locked ?? false);
	const unreadable = $derived(finder?.failed ?? false);
	const showSetup = $derived(
		app.status === 'ready' && !!finder?.ready && (!isSetUp(finder.setup) || changing)
	);

	$effect(() => {
		void lockedView;
		unlockError = null;
	});

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
	// session, and the Unlock that follows opens the stores again and lands here.
	const listOpen = $derived(
		!!session && !!finder?.ready && !!app.finderPack?.ready && isSetUp(finder.setup) && !changing
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
			await store.setSetup(setup);
			await store.setFilters((current) => withSetupChoices(current, choices));
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
	<h1 bind:this={headingEl} tabindex="-1">SkillBridge</h1>

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
				loadZips={() => session?.ensureZips() ?? Promise.resolve(undefined)}
				onsave={saveSetup}
				error={saveError}
			/>
		{:else if finder.ready && session}
			<List {session} {finder} card={program} />
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
