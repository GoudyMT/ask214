<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppGate from '$lib/components/AppGate.svelte';
	import ClockBackwardBanner from '$lib/components/ClockBackwardBanner.svelte';
	import { setProfileApp, type ProfileApp } from '$lib/profile/context';
	import {
		initProfileApp,
		provisionStore,
		subscribeBus,
		installLifecycle,
		createRelockEcho,
		relockAll,
		type Relockable
	} from '$lib/profile/app-init';
	import { createProfileStore } from '$lib/profile/store.svelte';
	import { createTimelineStateStore } from '$lib/timeline';
	import { createCalendarSyncStore } from '$lib/calendar/store.svelte';
	import { createByokStore } from '$lib/ask/byok/store';
	import { createProfileBus } from '$lib/broadcast/bus';
	import { createIdleTimer } from '$lib/profile/idle-timer';
	import { checkBrowserSupport } from '$lib/crypto/capability';
	import { openMtcDb } from '$lib/db/schema';
	import { wipeAllStores } from '$lib/db/wipe';
	import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
	import { safeLog } from '$lib/log/safelog';
	import { requestPersistentStorage } from '$lib/storage/persistence';
	import { setInstallApp, type InstallApp } from '$lib/install/context';
	import {
		createInstallController,
		readCapturedPrompt,
		type InstallController
	} from '$lib/install/install-prompt';
	import { isInstalled, isIOS } from '$lib/install/install-state';
	import { shellWidthFor } from '$lib/layout/shell-width';
	import { applyStorageChange, readChoice, syncThemeColor } from '$lib/theme/theme';
	import { stashRoute } from '$lib/feedback/context';

	let { children } = $props();

	// Shell content width per route: the whole shell (nav/main/footer) widens together on a wide
	// route (timeline -> 1024px) via the --shell-width CSS var; other routes keep the 720px column.
	const shellWidth = $derived(shellWidthFor(page.route.id));

	// Auto-lock the in-memory profile after 15 minutes of no user input (memory hygiene;
	// unlock is a transparent local-key re-decrypt in v1.0).
	const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

	// App-wide profile container, set synchronously (setContext must run during component
	// init). Populated by the client-only app-init in onMount below. The shell renders for
	// every status except `unsupported`; store-dependent UI reads `app.store` once ready.
	const app = $state<ProfileApp>({
		status: 'loading',
		store: null,
		timeline: null,
		calendar: null,
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	});
	setProfileApp(app);

	// Device-level install state (non-PII): populated in onMount since the detection and the
	// beforeinstallprompt capture are browser-only. The Home nudge and Settings install control read it.
	const install = $state<InstallApp>({
		canPrompt: false,
		installed: false,
		ios: false,
		persisted: false,
		promptInstall: () => Promise.resolve('unavailable')
	});
	setInstallApp(install);

	// Settings acts only on stored data (the date, calendar, lock, erase). Hide the tab on a fresh
	// no-date profile so it appears only once there is something to configure; a locked profile has
	// data (its persona reads 'none' only because the plaintext is sealed), so it still shows.
	// Settings is reachable whenever the app is ready: the "Online answers" panel is always configurable, so
	// even a fresh no-timeline user has something to set there (the timeline sections hide inside Settings).
	const showSettings = $derived(app.status === 'ready');

	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
		}

		// Cross-tab bus: created up front so the store can publish change/relock signals via
		// its onBroadcast seam, and so a sibling tab's signals reach this tab's store.
		const bus = createProfileBus();
		// Every store broadcasts through this seam so a relock answering a peer stays local; without
		// it each hop multiplies by (stores x tabs) and the channel saturates.
		const echo = createRelockEcho(bus);
		let destroyed = false;
		let teardownRuntime: (() => void) | null = null;

		// Client-only: IndexedDB + crypto are browser-only.
		void initProfileApp({
			checkSupport: checkBrowserSupport,
			openDb: () =>
				openMtcDb(undefined, () => {
					// Another tab on a newer bundle upgraded the shared DB and closed this connection;
					// the takeover offers a reload onto the new bundle instead of a silent, data-less tab.
					if (!destroyed) app.status = 'stale';
				}),
			bootstrap: bootstrapLocalKeystore,
			createStore: (db) => createProfileStore(db, { onBroadcast: (e) => echo.publish(e) })
		})
			.then((result) => {
				if (destroyed) return;
				if (result.status === 'unsupported') {
					app.cause = result.cause;
					app.status = 'unsupported';
					return;
				}
				app.store = result.store;
				// Registry-driven, so the erase covers stores that never provisioned - they are the ones
				// whose orphaned rows would otherwise block their own recovery.
				app.wipeAll = () => wipeAllStores(result.db);
				// The BYO-key store rides on the same db; it reads on demand and caches nothing, so it needs
				// no relock join and no async load - just make it available once the keystore is usable.
				app.byok = createByokStore(result.db);
				app.status = 'ready';

				// Wire the profile's relock/lifecycle FIRST and unconditionally (security: the
				// decrypted profile must always relock on idle/background). relockables is shared +
				// mutable, so the timeline store joins it once provisioned (installLifecycle + the
				// relocked handler read the list at event time).
				const relockables: Relockable[] = [result.store];
				// The ONE relock-everything seam. Every "lock" or "erase" walks this list; enumerating
				// stores at a call site is how the timeline's decrypted notes got left in memory twice.
				app.relockAll = () => relockAll(relockables, 'user');
				// refresh, not load: a peer's change is not the user asking to unlock, so each store
				// refuses the re-read if IT has relocked. The gate lives in the store, per store.
				const offBus = subscribeBus(bus, {
					relocked: () => echo.answer(() => relockables.forEach((r) => r.relockSync('peer'))),
					'profile-updated': () => void result.store.refresh(),
					'timeline-updated': () => void app.timeline?.refresh(),
					'calendar-updated': () => void app.calendar?.refresh()
				});
				const offLifecycle = installLifecycle(relockables, {
					win: window,
					doc: document,
					isHidden: () => document.visibilityState === 'hidden',
					createIdleTimer,
					idleThresholdMs: IDLE_THRESHOLD_MS
				});
				teardownRuntime = () => {
					offBus();
					offLifecycle();
				};

				// Timeline-state store rides on the same db + bus; it joins the relock set the moment
				// it exists, before its first read decrypts anything. A timeline init failure
				// degrades to profile-only (never blocks the wiring above).
				void provisionStore(
					result.db,
					(db) => createTimelineStateStore(db, { onBroadcast: (e) => echo.publish(e) }),
					(timeline) => relockables.push(timeline)
				)
					.then((timeline) => {
						if (destroyed) return;
						app.timeline = timeline;
					})
					.catch(() => safeLog({ code: 'E_INIT_FAILED' }));

				// Calendar-sync store rides on the same db + bus and joins the relock set the same
				// way; an init failure degrades to calendar-off, never blocking the wiring above.
				void provisionStore(
					result.db,
					(db) => createCalendarSyncStore(db, { onBroadcast: (e) => echo.publish(e) }),
					(calendar) => relockables.push(calendar)
				)
					.then((calendar) => {
						if (destroyed) return;
						app.calendar = calendar;
					})
					.catch(() => safeLog({ code: 'E_INIT_FAILED' }));
			})
			.catch(() => {
				// Hard init failure past the capability gate (e.g. a tampered keystore failing
				// load()). Opaque log only (no PII). The app shell stays usable; a dedicated
				// init-error / recovery surface is deferred to v1.1 (see Settings "Wipe" L5).
				safeLog({ code: 'E_INIT_FAILED' });
			});

		return () => {
			destroyed = true;
			teardownRuntime?.();
			bus.close();
		};
	});

	// Theme lifecycle, registered after app-init so this cosmetic side-effect never precedes the
	// profile/relock wiring: sync the address-bar tint to the persisted choice on load, and follow
	// theme changes made in other tabs (a `storage` event fires only in OTHER tabs). Client-only.
	onMount(() => {
		syncThemeColor(readChoice());
		window.addEventListener('storage', applyStorageChange);
		return () => window.removeEventListener('storage', applyStorageChange);
	});

	// Durability wiring (client-only). Two independent legs keep the on-device IndexedDB - which holds
	// the non-extractable AES-GCM key alongside the ciphertext - out of iOS eviction: being installed
	// exempts it from the 7-day inactivity timer, and a granted persist() exempts it from
	// storage-pressure eviction. Track BOTH ("installed" alone is not "safe"), and re-request persist()
	// when the user newly installs - the moment WebKit is most likely to grant it.
	onMount(() => {
		install.ios = isIOS();

		const refreshPersistence = async (): Promise<void> => {
			const outcome = await requestPersistentStorage();
			install.persisted = outcome === 'granted' || outcome === 'already';
		};

		let controller: InstallController;
		let wasInstalled = false;
		const sync = (): void => {
			const s = controller.snapshot();
			install.canPrompt = s.canPrompt;
			install.installed = s.installed;
			// Re-check persistence on the install transition (not every sync): a fresh install is the
			// moment persist() flips from likely-denied to likely-granted.
			if (s.installed && !wasInstalled) void refreshPersistence();
			wasInstalled = s.installed;
		};

		controller = createInstallController({
			target: window,
			isInstalled,
			initialPrompt: readCapturedPrompt,
			onChange: sync
		});
		// Seed from the current state so the initial sync is not treated as a transition; the
		// unconditional refreshPersistence() below covers the load-time request.
		wasInstalled = controller.snapshot().installed;
		sync();
		install.promptInstall = controller.promptInstall;
		void refreshPersistence();
		return controller.destroy;
	});
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<!-- The media-scoped meta must come first: a browser returns the first theme-color whose media
	     matches (or has none) in tree order, so a no-media default first would shadow the light one.
	     syncThemeColor() overrides both for an explicit choice; System leaves this OS-driven pair. -->
	<meta name="theme-color" content="#f5f7fa" media="(prefers-color-scheme: light)" />
	<meta name="theme-color" content="#0f1419" />
	<meta name="color-scheme" content="light dark" />
</svelte:head>

<AppGate {app}>
	<a class="skip-link" href="#main-content">Skip to content</a>

	<header>
		<nav aria-label="Primary" style:--shell-width={shellWidth}>
			<a href={resolve('/')} class="brand">Ask 214</a>
			<ul>
				<li><a href={resolve('/timeline')}>Timeline</a></li>
				<li><a href={resolve('/resources')}>Resources</a></li>
				{#if showSettings}
					<li><a href={resolve('/settings')}>Settings</a></li>
				{/if}
			</ul>
		</nav>
	</header>

	{#if app.status === 'ready' && app.store?.clockBackward}
		<ClockBackwardBanner onfix={() => void goto(resolve('/settings'))} />
	{/if}

	<main id="main-content" style:--shell-width={shellWidth}>
		{@render children()}
	</main>

	<footer style:--shell-width={shellWidth}>
		<p>
			An independent project to help service members navigate the steps to civilian life - not
			affiliated with the US Department of Defense, the Department of Veterans Affairs, or any
			branch of the US military.
		</p>
		<p>
			<a href={resolve('/about')}>About</a> &middot;
			<a href="https://github.com/GoudyMT/ask214" rel="external">Source</a>
			&middot;
			<a href={resolve('/feedback')} onclick={() => stashRoute(page.url.pathname)}>Feedback</a>
		</p>
	</footer>
</AppGate>

<style>
	/* Lock #4: sticky header (pure CSS, no JS). Background + z-index prevent */
	/* underlying content from showing through on scroll. */
	header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
		padding: var(--space-m) var(--space-l);
	}

	/* Tighter side padding on a phone: header, content, and footer share a 16px gutter so the nav is not
	   pinched at the edges AND the brand stays aligned with the body content column. */
	@media (max-width: 480px) {
		header,
		main,
		footer {
			padding: var(--space-m);
		}
	}

	/* Lock #2: right-aligned nav (brand left, nav right) via flex space-between. */
	/* Lock #1: 720px content container; 1024px wider variant ships when a */
	/* dashboard/timeline route lands (Phase 2+). */
	nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
	}

	/* Lock #7: inline horizontal nav (brand + Timeline/Resources/Settings; Settings appears only once a
	   separation date is set; About lives in the footer). Migrate to a bottom-tab-bar when the nav grows
	   to 4+ items (e.g. a future Tools section). */
	nav ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		gap: var(--space-m);
	}

	/* Quiet by default, promoted on hover/tap: the accent underline gives the press a visible target
	   state on touch, where there is no hover to rely on. */
	nav ul a {
		color: var(--color-fg-muted);
		text-decoration: none;
		padding: var(--space-xs) 0;
		border-bottom: 2px solid transparent;
	}
	nav ul a:hover {
		color: var(--color-fg);
		border-bottom-color: var(--color-accent);
	}
	nav ul a:active {
		color: var(--color-accent);
		border-bottom-color: var(--color-accent);
	}

	/* Lock #3: text wordmark, font-weight 600 (no logo until trademark clears). */
	.brand {
		font-weight: 600;
		text-decoration: none;
		color: var(--color-fg);
	}

	/* Lock #1 + #9: 720px content container; body content inherits the same width. */
	main {
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
		padding: var(--space-l);
		min-height: calc(100vh - 160px);
	}

	/* Lock #5: 2-line footer content (attribution disclaimer + About/Source links). */
	/* Lock #6: 14px footer text via --font-size-s (already shipped via app.css). */
	footer {
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
		border-top: 1px solid var(--color-border);
		padding: var(--space-l);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		text-align: center;
	}
	footer p {
		margin: var(--space-s) 0;
	}
</style>
