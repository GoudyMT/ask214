<script lang="ts">
	import { onMount } from 'svelte';
	import GlanceRow from '$lib/components/GlanceRow.svelte';
	import { getProfileApp } from '$lib/profile/context';
	import { safeLog } from '../../log/safelog';
	import { finderHomeRow, type FinderHomeInput } from './home-row';
	import { createFinderSession, type FinderSession } from './session.svelte';
	import { isSetUp, placeText } from './setup-state';

	// Home gives this nothing: it reads the stores itself, and says only whether it has a row, so Home can hide its
	// section when neither tool has one.
	let { onpresent }: { onpresent?: (present: boolean) => void } = $props();

	// A relock that lands while the week is being opened ends that run early; the run is asked again this many times.
	const MAX_RESTARTS = 2;

	const app = getProfileApp();

	let visible = $state(document.visibilityState !== 'hidden');
	let onLine = $state(navigator.onLine);
	let session = $state.raw<FinderSession | null>(null);
	// True once the week has been opened and checked against the network, so a count is never last week's.
	let settled = $state(false);
	// Whether a finder record is saved, asked only while locked (it counts rows and opens none); null until answered.
	let hasRecord = $state<boolean | null>(null);

	onMount(() => {
		const sync = () => {
			visible = document.visibilityState !== 'hidden';
			onLine = navigator.onLine;
		};
		document.addEventListener('visibilitychange', sync);
		window.addEventListener('online', sync);
		window.addEventListener('offline', sync);
		return () => {
			document.removeEventListener('visibilitychange', sync);
			window.removeEventListener('online', sync);
			window.removeEventListener('offline', sync);
		};
	});

	const locked = $derived(!!app.finder?.locked || app.store?.lockState === 'locked');
	const broken = $derived(app.finderFailed || !!app.finder?.failed || !!app.finderPack?.failed);
	const open = $derived(
		!broken &&
			!locked &&
			!!app.finder?.ready &&
			!!app.finderPack?.ready &&
			isSetUp(app.finder.setup)
	);

	$effect(() => {
		const finder = app.finder;
		hasRecord = null;
		if (!locked || !finder) return;
		let current = true;
		finder.hasRecord().then(
			(found) => {
				if (current) hasRecord = found;
			},
			() => safeLog({ code: 'E_INTERNAL' })
		);
		return () => {
			current = false;
		};
	});

	// One session for the visit, over the stores the layout provides once they exist. It is not started here: see below.
	$effect(() => {
		const finder = app.finder;
		const pack = app.finderPack;
		if (!finder || !pack) return;
		const made = createFinderSession({
			finder,
			pack,
			canFetch: () => document.visibilityState !== 'hidden'
		});
		session = made;
		return () => {
			made.destroy();
			session = null;
		};
	});

	// The week is opened and checked once the person is through setup and everything is open, and only while the page is
	// shown: a hidden page downloads nothing. A lock ends it and the Unlock that follows starts it again.
	$effect(() => {
		const made = session;
		if (!made || !open || !visible) return;
		let current = true;
		void (async () => {
			for (let tries = 0; current && tries <= MAX_RESTARTS; tries++) {
				await made.start();
				if (made.status !== 'loading') break;
			}
			if (current) settled = true;
		})();
		return () => {
			current = false;
			settled = false;
		};
	});

	const input = $derived.by((): FinderHomeInput | null => {
		if (broken) return null;
		if (locked) {
			if (hasRecord === null) return null;
			return {
				unlocked: false,
				online: onLine,
				setUp: hasRecord,
				missedWeeks: 0,
				newCount: 0,
				nearCount: 0,
				placeLabel: null
			};
		}
		const made = session;
		const finder = app.finder;
		if (!made || !finder || !open || !settled) return null;
		if (made.status === 'loading' || made.status === 'failed') return null;
		const place = finder.setup.place;
		const found = made.status === 'ready' ? made.matches : [];
		return {
			unlocked: true,
			online: onLine && made.status !== 'offline',
			setUp: true,
			missedWeeks: made.missedWeeks,
			newCount: found.filter((m) => made.isNewId(m.listing.i)).length,
			// Near means a program with one place of its own: online and several-state programs are listed but are not near.
			nearCount: place
				? found.filter((m) => m.placement.kind === 'point' || m.placement.kind === 'state').length
				: 0,
			placeLabel: place ? placeText(place) : null
		};
	});
	const row = $derived(input && finderHomeRow(input));

	$effect(() => {
		onpresent?.(row !== null);
		return () => onpresent?.(false);
	});
</script>

{#if row}
	<GlanceRow {row} to="/skillbridge" />
{/if}
