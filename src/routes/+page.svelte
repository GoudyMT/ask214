<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { waitForControl } from '$lib/ask/when-controlled';
	import AskView from '$lib/components/AskView.svelte';
	import EmbedWorker from '$lib/ask/embed-worker?worker';
	import {
		ASK_ERROR,
		AskError,
		CORPUS_BASE,
		createAskStore,
		createRecoveringEmbed,
		loadCorpus,
		type AskState
	} from '$lib/ask';
	import { ACCEPTED_CORPUS_VERSION } from '$lib/corpus';
	import { sourcesFromCorpus, type Source } from '$lib/ask/sources';
	import { createLazyCorpus } from '$lib/ask/corpus-loader';
	import { deviceFilesKept } from '$lib/ask/device-files';
	import { getProfileApp } from '$lib/profile/context';
	import { LocalToday } from '$lib/timeline/local-today.svelte';
	import type { HomeRow } from '$lib/timeline/home-glance';
	import { FAILED_ROW, loadHomeGlance } from '$lib/timeline/load-home-glance';
	import GlanceRow from '$lib/components/GlanceRow.svelte';
	import LockedPanel from '$lib/components/LockedPanel.svelte';
	import { loadPinUnlock } from '$lib/components/load-pin-unlock';
	import { getInstallApp } from '$lib/install/context';
	import { isNudgeDismissed, dismissNudge } from '$lib/install/dismissed';
	import InstallNudge from '$lib/components/InstallNudge.svelte';
	import { retrieveOnline } from '$lib/ask/online/retrieve-online';
	import { synthesize } from '$lib/ask/synthesis/synthesize';
	import {
		getDefaultMode,
		isOnlineConsented,
		setOnlineConsented,
		isSynthesisEnabled
	} from '$lib/ask/online-prefs';

	const app = getProfileApp();
	// A PIN tab with no keys is locked whatever the stores read: with nothing saved a store reads unlocked after a Lock. The
	// Unlock card then takes the place of the first-run invitation and of the row, and Ask stays open above it.
	const pinLocked = $derived(app.status === 'ready' && app.pinLocked === true);
	const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
	// First-run = a ready, unlocked profile with no persona yet. The on-ramp invites setup; once a
	// timeline exists the timeline's glance row takes its place.
	const showOnramp = $derived(
		app.status === 'ready' && !app.store?.locked && app.store?.persona.completeness === 'none'
	);

	// The returning user's row, read from the stores the layout loads. Locked follows the Timeline page: the profile, or
	// a timeline store locked with a set-up profile. Still loading shows no row, so it never reads as nothing due.
	const clock = new LocalToday();
	// The timeline code (its task list and date rules) loads only for someone with a profile, so a first visit to Home
	// downloads none of it. The row waits for it, as it waits for the stores.
	const returning = $derived(
		app.status === 'ready' &&
			!pinLocked &&
			!!app.store &&
			(app.store.locked || app.store.persona.completeness !== 'none')
	);
	let glanceCode = $state<Awaited<ReturnType<typeof loadHomeGlance>> | null>(null);
	// Code that never arrived (offline, before it was ever stored) still gets a row that says so, not a silent gap.
	let glanceLost = $state(false);
	$effect(() => {
		if (returning && !glanceCode && !glanceLost) {
			loadHomeGlance().then(
				(m) => (glanceCode = m),
				() => (glanceLost = true)
			);
		}
	});
	const row = $derived.by((): HomeRow | null => {
		if (glanceLost && returning) return FAILED_ROW;
		const code = glanceCode;
		if (!code || app.status !== 'ready' || !app.store) return null;
		if (app.store.locked) return code.timelineRow({ kind: 'locked' });
		const persona = app.store.persona;
		const timeline = app.timeline;
		if (persona.completeness === 'none' || !timeline) return null;
		if (timeline.failed) return FAILED_ROW;
		if (timeline.locked) return code.timelineRow({ kind: 'locked' });
		if (!timeline.ready) return null;
		const glance = code.readyGlance(persona, timeline.state, clock.now);
		return glance && code.timelineRow(glance);
	});

	// Ask store wiring: the store is created once the cache has been read (a lookup, no download - see onMount),
	// so the input, mode toggle, and feed are live at once. The corpus is fetched lazily - only a device query or
	// a "Read more" click needs it - so the ~3.5MB artifact stays off the initial page load (an eager fetch pins
	// LCP/TTI to its download). The ~23MB model + its worker are also lazy (created on the first embed, in onMount).
	let store = $state<ReturnType<typeof createAskStore> | null>(null);
	// Read only by loadSource, after the load that fills it - never by the template - so it needs no reactivity.
	let sources: Map<string, Source> | undefined;
	// Set when the page is left. A download waiting for the service worker checks it when the wait ends, so a setup
	// left behind starts nothing once the worker takes charge.
	let left = false;
	// A mode or a feed question picked before the store exists - it waits for the cache read - is held here and
	// handed to the store when it is made, so an early tap is not lost. The toggle shows the held mode until then:
	// the saved default, or the one just picked. A question keeps the mode it was picked in.
	let earlyMode = $state(getDefaultMode());
	// `keyboard`: the pill was pressed by keyboard or screen reader, so focus goes to the field once the question runs.
	let earlyQuery: { query: string; mode: 'device' | 'online'; keyboard: boolean } | undefined;
	let askView: ReturnType<typeof AskView> | undefined;

	// Whether a BYO key is saved, known while locked from a count of its row: an online answer then points to the Unlock
	// where the summary would be. The query and the key go nowhere new; the summary itself waits for the keys.
	let storedKey = $state(false);
	$effect(() => {
		const byok = app.byok;
		if (!pinLocked || !byok) {
			storedKey = false;
			return;
		}
		let current = true;
		byok.hasApiKey().then(
			(has) => {
				if (current) storedKey = has;
			},
			() => {
				if (current) storedKey = false;
			}
		);
		return () => {
			current = false;
		};
	});
	// The card is already on the page, so the press only takes the cursor into its field.
	function toUnlockCard(): void {
		document.getElementById('pin-unlock-field')?.focus();
	}

	// Memoized lazy corpus load; populates `sources` (the offline reader's source map) on first resolve. A
	// rejection is not cached, so a transient failure stays retryable rather than trapping the session.
	const getCorpus = createLazyCorpus(
		async () => {
			// The answer library is one of the first downloads too: waiting keeps it on a first visit.
			await waitForControl();
			if (left) throw new AskError(ASK_ERROR.CORPUS);
			return loadCorpus(fetch, CORPUS_BASE);
		},
		(c) => {
			sources = sourcesFromCorpus(c);
		}
	);
	// Resolve one source for the offline reader, loading the corpus on demand. Awaited by AskView's "Read
	// more" (which shows a loading state meanwhile), so the corpus is not fetched until a user reads a source.
	async function loadSource(sourceId: string): Promise<Source | null> {
		await getCorpus();
		return sources?.get(sourceId) ?? null;
	}

	const askState: AskState = $derived(store?.state ?? { kind: 'idle' });
	const ready = $derived(store !== null);
	// The below-hero band is idle-state content; once a query runs (any non-idle state), the results own
	// the space and the band steps aside.
	const isIdle = $derived(askState.kind === 'idle');

	const install = getInstallApp();
	// Steer a browser-tab user to install, but only where install is actually possible: a captured
	// prompt (Chromium) or iOS Safari (manual steps). Installed users already have the storage-eviction
	// exemption, so they never see it. Dismissal is a non-PII device flag, read synchronously since
	// this route is client-only.
	let nudgeDismissed = $state(isNudgeDismissed());
	const showInstallNudge = $derived(
		isIdle && !install.installed && !nudgeDismissed && (install.canPrompt || install.ios)
	);
	function dismissInstall(): void {
		dismissNudge();
		nudgeDismissed = true;
	}
	// Install and Dismiss both remove the nudge, and the button that was pressed goes with it: focus falls to the
	// page unless the person has already moved on, so it goes to the question field, the page's first control.
	async function closeNudge(action: () => unknown, press: MouseEvent): Promise<void> {
		await action();
		// Not after a tap or a click (detail 1+): a focused text field would open a phone's keyboard. A keyboard or a
		// screen reader presses with detail 0.
		await toQuestionField(!press.detail);
	}
	async function toQuestionField(keyboard: boolean): Promise<void> {
		await tick();
		if (keyboard && document.activeElement === document.body) askView?.focusField();
	}
	// The Unlock card is gone and focus fell to the page. Where it goes follows the same rule: after a keyboard press the
	// question field, and after a tap or a click the page heading, since a focused text field would open a phone's keyboard.
	let unlockByTouch = false;
	let heroEl: HTMLElement | undefined;
	async function afterUnlock(): Promise<void> {
		await tick();
		if (document.activeElement !== document.body) return;
		if (unlockByTouch) heroEl?.focus();
		else askView?.focusField();
	}

	// A lock of any kind (the person's, the idle timer's, another tab's, the page being hidden) clears the question and
	// the answer on screen: the page is going away, and its text with it. Ask answers again only when asked, so there
	// is nothing to read back on refresh. The list is offered once start-up resolves; the page leaves it when it goes.
	$effect(() =>
		app.joinRelock?.({
			relockSync: () => {
				store?.clear();
				askView?.clear();
			},
			refresh: () => Promise.resolve()
		})
	);

	onMount(() => {
		// The ~23MB model + its embed worker are created lazily, on the first query that needs them - never
		// on page load (the corpus is likewise lazy, via getCorpus above) - and made again after a failure.
		const { embed, dispose } = createRecoveringEmbed(() => new EmbedWorker());
		// Whether this device keeps every on-device file is read from the cache - a lookup, no download - before
		// the store exists, so the store asks before any download the device does not already hold.
		// eslint-disable-next-line no-restricted-properties -- a read-only lookup of which public files the device holds
		void deviceFilesKept(globalThis.caches).then((deviceKept) => {
			if (left) return;
			store = createAskStore({
				// The embed worker, and the model it downloads, are created only after the wait, so both go
				// through the service worker and are kept.
				embed: async (text) => {
					await waitForControl();
					if (left) throw new AskError(ASK_ERROR.EMBED);
					return embed(text);
				},
				getCorpus,
				deviceKept,
				// Route-bound closures keep fetch and the raw BYO key out of the store. A decoded corpus always
				// carries ACCEPTED_CORPUS_VERSION (the codec rejects any other), so the online handshake uses the
				// constant, not the loaded object - which lets online mode skip the corpus load entirely.
				retrieveOnline: (query) =>
					retrieveOnline(query, { fetch, expectedCorpusVersion: ACCEPTED_CORPUS_VERSION }),
				synthesize: async (query, chunks) => {
					try {
						const apiKey = (await app.byok?.readApiKey()) ?? null;
						if (apiKey === null) return { kind: 'degraded' }; // no key -> raw cards, no summary
						return await synthesize(query, chunks, { fetch, apiKey });
					} catch {
						return { kind: 'degraded' }; // a locked keystore or read failure degrades gracefully
					}
				},
				onlineConsented: isOnlineConsented,
				markOnlineConsent: () => setOnlineConsented(true),
				synthesisEnabled: isSynthesisEnabled
			});
			// The store opens online when capable (the on-ramp default); honor the held mode - an explicit device
			// choice, or one picked while the cache was read. A feed question picked in that time is asked now, in
			// the mode showing when it was picked, as it would have been with the store in place; a mode tapped
			// after it then applies to the next question.
			const first = earlyQuery?.mode ?? earlyMode;
			if (first === 'device') store.setMode('device');
			if (earlyQuery !== undefined) {
				void store.ask(earlyQuery.query);
				// The pill unmounts with the feed now, outside any press, so focus falls: hand it on as a press would.
				void toQuestionField(earlyQuery.keyboard);
			}
			if (earlyMode !== first) store.setMode(earlyMode);
		});
		return () => {
			left = true;
			dispose();
		};
	});
</script>

<svelte:head>
	<title>Ask 214</title>
	<meta
		name="description"
		content="Ask a question about your military transition and get answers backed by official sources, private by default."
	/>
</svelte:head>

<div class="home">
	<h1 bind:this={heroEl} class="home-hero" tabindex="-1">
		Answers for your military transition, from sources you can trust.
	</h1>

	<AskView
		bind:this={askView}
		{askState}
		{ready}
		{loadSource}
		onlineCapable={true}
		mode={store?.mode ?? earlyMode}
		showNudge={store?.showNudge ?? false}
		onAsk={(q, press) =>
			store
				? void store.ask(q)
				: (earlyQuery = {
						query: q,
						mode: earlyMode,
						keyboard: !!press && !press.detail
					})}
		onSetUp={() => store?.setUp()}
		onDismiss={() => store?.dismissSetup()}
		onSetMode={(m) => (store ? store.setMode(m) : (earlyMode = m))}
		onConsentOnline={() => store?.consentOnline()}
		onStayDevice={() => store?.stayOnDevice()}
		onDismissNudge={() => store?.dismissNudge()}
		onOfferDevice={(q) => {
			store?.setMode('device');
			void store?.ask(q);
		}}
		onRetryOnline={(q) => {
			store?.setMode('online');
			void store?.ask(q);
		}}
		onUnlockSummaries={pinLocked && storedKey && isSynthesisEnabled() ? toUnlockCard : undefined}
	/>

	{#if showInstallNudge}
		<div class="home-install">
			<InstallNudge
				canPrompt={install.canPrompt}
				onInstall={(e) => void closeNudge(install.promptInstall, e)}
				ondismiss={(e) => void closeNudge(dismissInstall, e)}
			/>
		</div>
	{/if}

	{#if pinLocked}
		<hr class="home-divider" />
		<!-- The card and its crypto load on demand; a card that cannot be fetched says so and offers a reload. The wrapper
		     only notes how the card was pressed, for where focus goes once it is gone. -->
		<div
			onclickcapture={(e) => (unlockByTouch = e.detail > 0)}
			onkeydowncapture={(e) => e.key === 'Enter' && (unlockByTouch = false)}
		>
			{#await loadPinUnlock() then unlockCard}
				<unlockCard.default onunlocked={() => void afterUnlock()} />
			{:catch}
				<LockedPanel onunlock={() => location.reload()} error={UNLOCK_FAILED} />
			{/await}
		</div>
	{:else if isIdle && showOnramp}
		<hr class="home-divider" />
		<section class="home-onramp" aria-labelledby="home-onramp-heading">
			<h2 id="home-onramp-heading">Make it yours</h2>
			<p>
				Add your separation date and Ask 214 builds a timeline of what to do and when - tailored to
				your date, still fully on your device.
			</p>
			<a class="home-onramp__action" href={resolve('/wizard')}>Set up your timeline</a>
		</section>
	{:else if isIdle && row}
		<hr class="home-divider" />
		<!-- A plain region, not a live one: it is read when reached, never announced on load. -->
		<section class="home-glance" aria-labelledby="home-glance-heading">
			<h2 id="home-glance-heading" class="home-glance__heading">For you</h2>
			<GlanceRow {row} to="/timeline" />
		</section>
	{/if}
</div>

<style>
	/* The hero (headline + input + trust + examples) is centered; results render left-aligned inside
	   AskView for readability. Exact alignment + spacing is deferred-polish (refine against the mockup). */
	.home {
		max-width: 640px;
		margin: 0 auto;
		text-align: center;
	}
	.home-hero {
		font-size: var(--font-size-h1-fluid);
		line-height: 1.15;
		margin: var(--space-xl) 0 var(--space-l);
	}
	/* Where focus goes after a tap on Unlock: the app's ring (app.css), as on a button. */
	.home-hero:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	/* The nudge card holds left-aligned content inside the centered hero column. */
	.home-install {
		margin-top: var(--space-xl);
		text-align: left;
	}
	/* Separates the Ask from the below-hero surface. Idle-only: once a query runs the results own the
	   page and this whole block steps aside. */
	.home-divider {
		border: 0;
		border-top: 1px solid var(--color-border);
		margin: var(--space-xxl) 0 var(--space-l);
	}
	.home-onramp {
		margin-top: 0;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 4px solid var(--color-accent);
		border-radius: var(--radius-m);
		padding: var(--space-l);
		text-align: left;
	}
	.home-onramp h2 {
		margin: 0 0 var(--space-xs);
		font-size: var(--font-size-l);
	}
	.home-onramp p {
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-m);
		font-size: var(--font-size-s);
	}
	.home-onramp__action {
		display: inline-block;
		background: var(--color-accent);
		color: var(--color-bg);
		padding: var(--space-s) var(--space-l);
		border-radius: var(--radius-m);
		font-weight: 600;
		text-decoration: none;
	}
	.home-onramp__action:hover {
		background: var(--color-accent-muted);
	}
	/* The rows read as content under the hero, left-aligned like the results. */
	.home-glance {
		text-align: left;
	}
	/* Named for screen readers only; on screen each row names its own tool. The same rule several components carry. */
	.home-glance__heading {
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
