<script lang="ts">
	import { untrack } from 'svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { safeLog } from '../../log/safelog';
	import { workerBypassesFinderData } from '../../sw/finder-bypass';
	import type { IndexFile } from '../contract/listing';
	import { STATE_EXTENTS } from '../contract/state-extents';
	import type { ZipsTable } from '../contract/tables';
	import { fetchIndex } from '../fetch/fetch-files';
	import { STATE_NAMES } from '../search/state-names';
	import { placePoint } from '../state/distance';
	import { selectRegionFiles, type SelectInput } from '../state/select-files';
	import type { FinderSetup } from '../state/types';
	import PackSettings from './PackSettings.svelte';
	import { createFinderSession, type FinderSession } from './session.svelte';
	import { isSetUp } from './setup-state';

	// This part reads the finder's own stores itself, so Settings names none of the finder's fields.
	const app = getProfileApp();
	const finder = $derived(app.finder);
	const pack = $derived(app.finderPack);
	// Nothing of the person is read or drawn unless both stores are open: a Lock closes them together.
	const open = $derived(!!finder?.ready && !!pack?.ready);

	const NOT_SAVED = 'Could not save the listings right now. Try again.';
	const NOT_REMOVED = 'Could not remove the listings right now. Try again.';

	let busy = $state(false);
	let error = $state<string | null>(null);
	let session = $state.raw<FinderSession | null>(null);
	// The week's index, fetched alone when the pack holds none, only to say how large a save would be.
	let offerIndex = $state.raw<IndexFile | undefined>(undefined);
	let zips = $state.raw<ZipsTable | undefined>(undefined);

	// One session while the page is up: it is what downloads a week, and what the Lock and Remove empty.
	$effect(() => {
		const f = finder;
		const p = pack;
		if (!f || !p) return;
		const made = createFinderSession({ finder: f, pack: p });
		session = made;
		return () => {
			made.destroy();
			session = null;
		};
	});

	/** "Near 21046, within 100 mi", "In Maryland"; null for a person who has not been through setup. */
	function setupWords(setup: FinderSetup): string | null {
		if (!isSetUp(setup)) return null;
		const place = setup.place;
		if (place === undefined) return 'No place chosen';
		if (place.kind === 'state') return `In ${STATE_NAMES[place.state]}`;
		const near = `Near ${place.zip}`;
		if (setup.radius === undefined) return near;
		return setup.radius === 'any' ? `${near}, any distance` : `${near}, within ${setup.radius} mi`;
	}

	// A ZIP is a point only through the ZIP table, which the session reads from the pack or fetches once.
	$effect(() => {
		const s = session;
		if (!open || !s || finder?.setup.place?.kind !== 'zip') return;
		void s.ensureZips().then((table) => (zips = table));
	});

	// With no week held, its index alone says what a save would cost; nothing else is fetched before the person taps,
	// and only once the worker in charge has said it keeps no copy of data files.
	$effect(() => {
		if (!open || pack?.index !== undefined || untrack(() => offerIndex) !== undefined) return;
		let cancelled = false;
		void workerBypassesFinderData()
			.then((passes) => (passes ? fetchIndex() : undefined))
			.then((index) => {
				if (!cancelled && index) offerIndex = index;
			})
			.catch(() => safeLog({ code: 'E_INTERNAL' }));
		return () => {
			cancelled = true;
		};
	});

	// The files this person's place needs, chosen as the session chooses them for a download.
	const wanted = $derived.by((): ReadonlySet<string> | null => {
		const setup = finder?.setup;
		if (!open || setup === undefined) return null;
		let place: SelectInput['place'];
		if (setup.place?.kind === 'zip') {
			const where = placePoint(setup.place, zips);
			if (!where) return null;
			place = { kind: 'point', la: where.la, lo: where.lo, state: where.state };
		} else if (setup.place?.kind === 'state') {
			place = { kind: 'state', state: setup.place.state };
		}
		return new Set(
			selectRegionFiles(
				{
					...(place ? { place } : {}),
					...(setup.radius !== undefined ? { radiusMiles: setup.radius } : {}),
					...(setup.territories ? { territories: true } : {}),
					...(setup.overseas ? { overseas: true } : {})
				},
				STATE_EXTENTS
			)
		);
	});

	const bytesOf = (index: IndexFile) =>
		wanted === null
			? null
			: index.files.filter((f) => wanted.has(f.name)).reduce((n, f) => n + f.bytes, 0);

	// The pack keeps no list of which files it holds; the index it holds lists the week's files, so what is held is
	// the files this place's download would have kept. A ZIP whose table is not at hand yet reads as the whole week
	// rather than as nothing.
	const held = $derived.by(() => {
		const index = pack?.index;
		if (!open || index === undefined) return null;
		return {
			bytes: bytesOf(index) ?? index.files.reduce((n, f) => n + f.bytes, 0),
			pullDate: index.pullDate
		};
	});
	const offerBytes = $derived(
		!open || pack?.index !== undefined || !offerIndex ? null : bytesOf(offerIndex)
	);

	async function save(): Promise<void> {
		if (!session || !pack) return;
		error = null;
		busy = true;
		try {
			await session.start();
			if (pack.index === undefined) error = NOT_SAVED;
		} catch {
			error = NOT_SAVED;
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<void> {
		if (!pack) return;
		error = null;
		busy = true;
		try {
			await pack.drop();
		} catch {
			error = NOT_REMOVED;
		} finally {
			busy = false;
		}
	}
</script>

{#if open && finder}
	<div class="finder-settings">
		<PackSettings
			setupSummary={setupWords(finder.setup)}
			{held}
			{offerBytes}
			{busy}
			{error}
			onsave={() => void save()}
			onremove={() => void remove()}
		/>
	</div>
{/if}

<style>
	.finder-settings {
		margin-top: var(--space-l);
	}
</style>
