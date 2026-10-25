<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { version } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppGate from '$lib/components/AppGate.svelte';
	import ClockBackwardBanner from '$lib/components/ClockBackwardBanner.svelte';
	import InitErrorBanner from '$lib/components/InitErrorBanner.svelte';
	import { setProfileApp, type ProfileApp } from '$lib/profile/context';
	import {
		initProfileApp,
		provisionStore,
		subscribeBus,
		installLifecycle,
		createJoinRelock,
		createRelockEcho,
		createSessionRelockable,
		readKeyState,
		relockAll,
		relockEachSync,
		reloadOnSignalWhenShown,
		reloadWhenShown,
		superviseStartup,
		type Relockable
	} from '$lib/profile/app-init';
	import { createProfileStore } from '$lib/profile/store.svelte';
	import { createTimelineStateStore, type TimelineStateStore } from '$lib/timeline/state.svelte';
	import { createCalendarSyncStore, type CalendarSyncStore } from '$lib/calendar/store.svelte';
	import { createByokStore } from '$lib/ask/byok/store';
	import { createProfileBus, type BusSignal } from '$lib/broadcast/bus';
	import { bumpCounter } from '$lib/keystore/app-lock-store';
	import { dropSession, getSession, setOnSessionMismatch } from '$lib/keystore/session';
	import {
		checkStoredBytes,
		keystoreHasIdentity,
		readStoredBytes,
		sameRecords,
		type StoredBytes
	} from '$lib/profile/damaged-bytes';
	import { createIdleTimer } from '$lib/profile/idle-timer';
	import { IDLE_THRESHOLD_MS } from '$lib/profile/idle-threshold';
	import { checkBrowserSupport } from '$lib/crypto/capability';
	import { openMtcDb } from '$lib/db/schema';
	import { startReload, stopReloadForLock } from '$lib/profile/pending-reload';
	import { markRaised, takeOverIfRaised } from '$lib/sw/take-over';
	import { wipeAllStores } from '$lib/db/wipe';
	import { isDamagedRecord, stillDamaged } from '$lib/profile/damaged';
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
	import BottomBar from '$lib/layout/BottomBar.svelte';
	import {
		HIDE_AFTER_PX,
		nextHeaderState,
		PHONE_QUERY,
		startHeaderState
	} from '$lib/layout/header-scroll';
	import { shellWidthFor } from '$lib/layout/shell-width';
	import { applyStorageChange, readChoice, syncThemeColor } from '$lib/theme/theme';
	import { stashRoute } from '$lib/feedback/context';
	let { children } = $props();

	// After a database raise, this release's worker takes over at once (take-over.ts).
	const takeOver = (raised?: boolean) => {
		if (raised) markRaised(version);
		void takeOverIfRaised(navigator.serviceWorker, version);
	};

	// Shell content width: one width for every route (shell-width.ts), set on nav, main and footer through
	// the --shell-width CSS var. The 720px in the styles below is only the fallback for a missing var.
	const shellWidth = $derived(shellWidthFor());

	// App-wide profile container, set synchronously (setContext must run during component
	// init). Populated by the client-only app-init in onMount below. The shell renders for
	// every status except the two takeovers, `unsupported` and `stale`; store-dependent UI reads `app.store` once ready.
	const app = $state<ProfileApp>({
		status: 'loading',
		store: null,
		timeline: null,
		calendar: null,
		byok: null,
		cause: null,
		db: null,
		wipeAll: null,
		relockAll: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
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

	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
			takeOver();
		}

		// Cross-tab bus: created up front so the store can publish change/relock signals via
		// its onBroadcast seam, and so a sibling tab's signals reach this tab's store.
		const bus = createProfileBus();
		// Every store broadcasts through this seam so a relock answering a peer stays local; without
		// it each hop multiplies by (stores x tabs) and the channel saturates.
		const echo = createRelockEcho(bus);
		// With a PIN set an idle lock stays in its own tab: another tab idling is not this person leaving, so only a Lock
		// and a key change reach the others.
		const broadcast = (e: BusSignal) => {
			if (app.keyMode === 'pin' && e.type === 'relocked' && e.reason === 'idle') return;
			echo.publish(e);
		};
		let destroyed = false;
		let teardownRuntime: (() => void) | null = null;

		const isHidden = () => document.visibilityState === 'hidden';
		// Client-only: IndexedDB + crypto are browser-only. The status is set by superviseStartup (the timeout, a late
		// result, a takeover that came first), so the callbacks below only wire what each outcome needs.
		const cancelStartup = superviseStartup(
			// onBlocked: another tab still holds an older connection open. The open waits and finishes by itself once
			// that tab closes; meanwhile the banner says so instead of an empty shell.
			(onBlocked) =>
				initProfileApp({
					checkSupport: checkBrowserSupport,
					openDb: () =>
						openMtcDb(
							undefined,
							() => {
								// Another tab on a newer bundle upgraded the shared DB and closed this connection;
								// the takeover offers a reload onto the new bundle instead of a silent, data-less tab.
								if (!destroyed) app.status = 'stale';
							},
							onBlocked,
							() => takeOver(true)
						),
					bootstrap: bootstrapLocalKeystore,
					createStore: (db) => createProfileStore(db, { onBroadcast: broadcast }),
					readKeyState
				}),
			app,
			(result) => {
				if (destroyed) return;
				if (result.status === 'unsupported') {
					app.cause = result.cause;
					return;
				}
				// The saved data failed its own checks: no reload can read it, so the erase is the way back. It needs only
				// the open database - it clears every store by registry name. Another tab may erase this data and start
				// again meanwhile, so any signal from another tab reloads this one (once shown: a reload decrypts), and the erase checks the data once
				// more first: data that now reads is never wiped - the page reloads onto it, and the throw stops the
				// erase before it clears anything else.
				if (result.status === 'damaged') {
					safeLog({ code: 'E_INIT_FAILED' });
					// Nothing is decrypted here, so the list starts empty: only a backup Check joins it, and the Erase's
					// first step relocks it. The lifecycle and its idle timer end that Check like any other session.
					const relockables: Relockable[] = [];
					const offLifecycle = installLifecycle(relockables, {
						win: window,
						doc: document,
						isHidden,
						createIdleTimer,
						idleThresholdMs: IDLE_THRESHOLD_MS,
						lockOnLongAbsence: () => app.keyMode === 'pin'
					});
					app.relockAll = () => relockAll(relockables, 'user');
					app.joinRelock = createJoinRelock(relockables);
					const offReload = reloadWhenShown(bus, document, () => location.reload());
					teardownRuntime = () => {
						offReload();
						offLifecycle();
					};
					app.db = result.db;
					app.wipeAll = async () => {
						const check = createProfileStore(result.db);
						const damaged = await stillDamaged(async () => {
							await check.load();
							check.relockSync('user');
						});
						if (!damaged) {
							location.reload();
							// E_NO_LONGER_DAMAGED: Settings reads it as "nothing failed" (a fixed code, so its page needs no import).
							throw new Error('E_NO_LONGER_DAMAGED');
						}
						await wipeAllStores(result.db);
					};
					return;
				}
				app.store = result.store;
				// A PIN set means this tab opened with no key: nothing is read until the person unlocks.
				const pin = result.keyMode === 'pin';
				app.keyMode = result.keyMode ?? 'local';
				app.pinLocked = pin;
				// Registry-driven, so the erase covers stores that never provisioned - they are the ones
				// whose orphaned rows would otherwise block their own recovery.
				app.db = result.db;
				// With a PIN the Erase also forgets this tab's keys and tells the others, which find no row (or a new one).
				app.wipeAll = async () => {
					await wipeAllStores(result.db);
					if (app.keyMode !== 'pin') return;
					relockEachSync(relockables, 'user');
					echo.publish({ type: 'keys-changed' });
				};
				// The BYO-key store rides on the same db; it reads on demand and caches nothing, so it needs
				// no relock join and no async load - just make it available once the keystore is usable.
				app.byok = createByokStore(result.db);

				// Wire the profile's relock/lifecycle FIRST and unconditionally (security: the
				// decrypted profile must always relock on idle/background). relockables is shared +
				// mutable, so the timeline store joins it once provisioned (installLifecycle + the
				// relocked handler read the list at event time).
				// The session relockable stands first: a relock that is not page hygiene forgets the keys before any store
				// answers, so a store that cannot be reached still loses them.
				const relockables: Relockable[] = [
					createSessionRelockable(() => {
						if (app.keyMode === 'pin') app.pinLocked = true;
					}),
					result.store
				];
				// The ONE relock-everything seam. Every "lock" or "erase" walks this list; enumerating
				// stores at a call site is how the timeline's decrypted notes got left in memory twice.
				// A lock (here or from another tab) that lands while a reload of the app's own waits out its grace cancels
				// it, as the reload would decrypt again (pending-reload.ts). The tab then goes on as one locked before the
				// signal (below).
				const lockStopsReload = () => {
					if (!stopReloadForLock()) return;
					if (result.store.locked) app.reloadOnUnlock = true;
					else app.replacedNotice = true;
				};
				app.relockAll = () => {
					relockAll(relockables, 'user');
					lockStopsReload();
					// A tab asleep in the back/forward cache, or with no BroadcastChannel, hears of this Lock only as the counter.
					if (app.keyMode === 'pin')
						bumpCounter(result.db).catch(() => safeLog({ code: 'E_INTERNAL' }));
				};
				// The damaged screen of a ready tab: the plaintext goes, and the erase checks once more that the data is still
				// damaged (another tab may have repaired or replaced it) before it wipes, then forgets the keys and tells the others.
				app.enterDamaged = (check) => {
					relockEachSync(relockables, 'hygiene');
					app.status = 'damaged';
					app.wipeAll = async () => {
						if (!(await stillDamaged(check))) {
							location.reload();
							throw new Error('E_NO_LONGER_DAMAGED');
						}
						await wipeAllStores(result.db);
						dropSession();
						echo.publish({ type: 'keys-changed' });
					};
				};
				// After the person has set a session: read every store as an unlock does. The profile must open; a timeline or
				// calendar that cannot be read never blocks it, as in the shipped Unlock.
				app.unlockStores = async () => {
					const held = getSession();
					// Read before the load as well as after a failure: only bytes that were the same on both sides of the load
					// are the ones it read and failed on. Another tab's save in between changes them (its marks only go up).
					const before = held ? await readStoredBytes(result.db).catch(() => null) : null;
					try {
						await result.store.load();
					} catch (e) {
						// The bytes that failed, taken before the lock: damage is this tab's only while the rows are still the ones
						// these keys opened (another tab may have erased, restored or changed the lock meanwhile).
						let seen: StoredBytes | null = null;
						if (before && held && isDamagedRecord(e)) {
							const now = await readStoredBytes(result.db).catch(() => null);
							if (
								now &&
								sameRecords(now, before) &&
								now.counter === held.counter &&
								keystoreHasIdentity(now.keystore, held.identity)
							) {
								seen = now;
							}
						}
						// Fail closed: no keys and no plaintext stay behind the lock card, and a retry is a fresh unlock.
						echo.answer(() => relockEachSync(relockables, 'peer'));
						const bytes = seen;
						if (bytes) app.enterDamaged?.(() => checkStoredBytes(result.db, bytes));
						throw e;
					}
					const rest = await Promise.allSettled([timelineStore?.load(), calendarStore?.load()]);
					if (rest.some((r) => r.status === 'rejected')) safeLog({ code: 'E_INIT_FAILED' });
					// A Lock that landed while the other stores were read leaves the lock up; a switch away did not lock anything.
					if (held && getSession() === held && result.store.lockState !== 'locked') {
						app.pinLocked = false;
					}
				};
				app.joinRelock = createJoinRelock(relockables);
				app.publish = (s) => echo.publish(s);
				// refresh, not load: a peer's change is not the user asking to unlock, so each store
				// refuses the re-read if IT has relocked. The gate lives in the store, per store.
				const offBus = subscribeBus(bus, {
					relocked: (s) => {
						echo.answer(() =>
							relockEachSync(relockables, 'peer', s.reason ? { peerReason: s.reason } : undefined)
						);
						lockStopsReload();
					},
					'profile-updated': () => result.store.refresh(),
					'timeline-updated': () => app.timeline?.refresh(),
					'calendar-updated': () => app.calendar?.refresh(),
					// A restore in another tab replaced the data: drop what this tab decrypted first (no broadcast; a
					// locked store stays locked), then reload as the wiring below decides. The keys went with the data.
					'data-replaced': () => {
						relockEachSync(relockables, 'hygiene');
						if (app.keyMode !== 'pin') return;
						dropSession();
						app.pinLocked = true;
					},
					// Another tab turned the PIN on, changed it, removed it or erased: nothing here fits the rows any more.
					// A tab that finds a local row (or none) needs no PIN, and a locked tab never re-reads by itself.
					'keys-changed': async () => {
						echo.answer(() => relockEachSync(relockables, 'peer'));
						const { mode } = await readKeyState(result.db);
						app.keyMode = mode === 'pin' ? 'pin' : 'local';
						if (mode === 'pin') app.pinLocked = true;
						else if (app.pinLocked) {
							// The reload decrypts, so a tab nobody can see waits until it is shown.
							document.addEventListener('visibilitychange', reloadOnShow);
							reloadOnShow();
						}
					}
				});
				const reloadOnShow = () => {
					if (document.visibilityState === 'hidden') return;
					document.removeEventListener('visibilitychange', reloadOnShow);
					location.reload();
				};
				// A locked tab never reloads itself, because a reload decrypts. A returning user's tab reloads on its Unlock; a
				// first-run tab has no Unlock, so it offers a Reload line. Off the setup form: it would save over the
				// restored date.
				const offReplaced = reloadOnSignalWhenShown(
					bus,
					'data-replaced',
					document,
					() => result.store.lockState === 'locked',
					() => {
						if (result.store.locked) app.reloadOnUnlock = true;
						else app.replacedNotice = true;
					},
					() =>
						startReload(() =>
							location.pathname === resolve('/wizard')
								? location.replace(resolve('/timeline'))
								: location.reload()
						)
				);
				const offLifecycle = installLifecycle(relockables, {
					win: window,
					doc: document,
					isHidden,
					createIdleTimer,
					idleThresholdMs: IDLE_THRESHOLD_MS,
					lockOnLongAbsence: () => app.keyMode === 'pin'
				});
				// Another tab changed the lock under a live session: forget the keys and show the PIN lock.
				setOnSessionMismatch(() => {
					relockEachSync(relockables, 'peer');
					app.pinLocked = true;
				});
				teardownRuntime = () => {
					offBus();
					offReplaced();
					offLifecycle();
					setOnSessionMismatch(null);
					document.removeEventListener('visibilitychange', reloadOnShow);
				};

				// Timeline-state store rides on the same db + bus; it joins the relock set the moment
				// it exists, before its first read decrypts anything. A timeline init failure
				// degrades to profile-only (never blocks the wiring above).
				let timelineStore: TimelineStateStore | null = null;
				void provisionStore(
					result.db,
					(db) => createTimelineStateStore(db, { onBroadcast: broadcast }),
					(timeline) => {
						relockables.push(timeline);
						timelineStore = timeline;
						// Landed locked, and quietly: this is no one's Lock, so the other tabs are not told.
						if (pin) echo.answer(() => timeline.relockSync('peer'));
					},
					isHidden,
					pin
				)
					.then((timeline) => {
						if (destroyed) return;
						app.timeline = timeline;
					})
					.catch(() => {
						safeLog({ code: 'E_INIT_FAILED' });
						// Handed over all the same: the store says its load failed, so the Timeline shows a note
						// instead of every task as not started.
						if (!destroyed) app.timeline = timelineStore;
					});

				// Calendar-sync store rides on the same db + bus and joins the relock set the same
				// way; an init failure degrades to calendar-off, never blocking the wiring above.
				let calendarStore: CalendarSyncStore | null = null;
				void provisionStore(
					result.db,
					(db) => createCalendarSyncStore(db, { onBroadcast: broadcast }),
					(calendar) => {
						relockables.push(calendar);
						calendarStore = calendar;
						if (pin) echo.answer(() => calendar.relockSync('peer'));
					},
					isHidden,
					pin
				)
					.then((calendar) => {
						if (destroyed) return;
						app.calendar = calendar;
					})
					.catch(() => {
						safeLog({ code: 'E_INIT_FAILED' });
						// Handed over all the same: the store says its load failed, so Settings says the calendar
						// settings could not be read instead of waiting on a store that never arrives.
						if (!destroyed) app.calendar = calendarStore;
					});
			}
		);

		return () => {
			destroyed = true;
			cancelStartup();
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

	// Header hiding, on a phone only (rules in header-scroll.ts): it slides away on a scroll down and returns on a scroll
	// up or when focus enters it. The flag is also set on <html> so the Timeline's sticky chips can take its place.
	let headerEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = headerEl;
		if (!el) return;
		const phone = window.matchMedia(PHONE_QUERY);
		const root = document.documentElement;
		let state = startHeaderState(window.scrollY);
		const setHidden = (hidden: boolean) => {
			el.toggleAttribute('data-hidden', hidden);
			root.toggleAttribute('data-header-hidden', hidden);
		};
		const onScroll = () => {
			state = nextHeaderState(state, window.scrollY);
			// A header holding focus stays on screen, so the page is not told it is hidden.
			setHidden(state.hidden && !el.contains(document.activeElement));
		};
		// Focus entering the header brings it back, and the hide distance counts from there.
		// The bar never moves, so a control focused under it has to. Chromium does that from scroll-padding-bottom, but
		// WebKit leaves a control that is already inside the window where it is, and scrolls to one below the window only
		// after focusin, to under the bar - so a control below the window is looked at again for up to half a second. A
		// control that starts in the window and runs under the bar is moved up, but never past its first line (the
		// header's bottom while a move that short keeps it shown, the top of the window when the move hides it).
		// The bar's own links stay put, and so does the page behind a modal dialog, which sits above the bar.
		const bar = document.querySelector('.bottom-bar');
		const onFocusIn = ({ target }: FocusEvent) => {
			if (!(target instanceof Element)) return;
			if (el.contains(target)) {
				state = startHeaderState(window.scrollY);
				return setHidden(false);
			}
			if (!bar || target.closest('.bottom-bar,dialog[open]')) return;
			let frames = 30;
			const check = () => {
				if (document.activeElement !== target) return;
				const { top, bottom } = target.getBoundingClientRect();
				if (top >= window.innerHeight) {
					if (--frames) requestAnimationFrame(check);
					return;
				}
				const room = bottom - bar.getBoundingClientRect().top;
				const shift = Math.min(
					room,
					room > HIDE_AFTER_PX ? top : top - el.getBoundingClientRect().bottom
				);
				// Whole pixels: WebKit drops a fraction of a pixel, which would leave the control just under the bar.
				if (shift > 0) window.scrollBy(0, Math.ceil(shift));
			};
			check();
		};
		// At a large text size the labels wrap and the bar grows, so the room the page keeps for it follows its real
		// height: its links and its top border (the safe-area inset is added where the room is used).
		const sizer = new ResizeObserver((entries) => {
			for (const e of entries)
				root.style.setProperty('--bottom-bar-height', `${e.contentRect.height + 1}px`);
		});
		const stop = () => {
			window.removeEventListener('scroll', onScroll);
			document.removeEventListener('focusin', onFocusIn);
			sizer.disconnect();
			setHidden(false);
		};
		// Crossing 600px in either direction starts over: a header hidden on a phone must not stay hidden on a desktop.
		const sync = () => {
			stop();
			if (!phone.matches) return;
			state = startHeaderState(window.scrollY);
			window.addEventListener('scroll', onScroll);
			document.addEventListener('focusin', onFocusIn);
			if (bar) sizer.observe(bar);
		};
		sync();
		phone.addEventListener('change', sync);
		return () => {
			phone.removeEventListener('change', sync);
			stop();
		};
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

	<header bind:this={headerEl}>
		<div class="header-row" style:--shell-width={shellWidth}>
			<a href={resolve('/')} class="brand">Ask 214</a>
			<nav aria-label="Primary">
				<ul>
					<li><a href={resolve('/timeline')}>Timeline</a></li>
					<li><a href={resolve('/resources')}>Resources</a></li>
					<!-- Settings is reachable whenever the app is ready: the "Online answers" panel is always configurable,
					     so even a fresh no-timeline user has something to set there (the timeline sections hide inside
					     Settings). And when the saved data is damaged, where its erase is the only way back. -->
					{#if app.status === 'ready' || app.status === 'damaged'}
						<li><a href={resolve('/settings')}>Settings</a></li>
					{/if}
				</ul>
			</nav>
		</div>
	</header>

	<!-- Fixed on screen, so its place in the page is free to be here: below 600px it is the only menu, so a keyboard user
	     reaches it right after the brand (the desktop menu is in the header too), and "Skip to content" skips it. -->
	<BottomBar />

	{#if app.status === 'ready' && app.store?.clockBackward}
		<ClockBackwardBanner onfix={() => void goto(resolve('/settings'))} />
	{:else if app.status === 'error' || app.status === 'damaged'}
		<InitErrorBanner damaged={app.status === 'damaged'} />
	{/if}

	<main id="main-content" style:--shell-width={shellWidth}>
		{#if app.replacedNotice}
			<p role="status">
				Data on this device was replaced from a backup in another tab. Reload to see it.
				<button type="button" onclick={() => location.replace(resolve('/timeline'))}>Reload</button>
			</p>
		{/if}
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
			<!-- On More the page the person came from is already remembered, and "/more" would clear it. -->
			<a
				href={resolve('/feedback')}
				onclick={() => {
					if (page.url.pathname !== '/more') stashRoute(page.url.pathname);
				}}>Feedback</a
			>
			&middot;
			<a href="https://github.com/GoudyMT/ask214/releases/tag/v{__APP_VERSION__}" rel="external"
				>v{__APP_VERSION__}</a
			>
		</p>
	</footer>
</AppGate>

<style>
	/* Sticky header. Background + z-index prevent */
	/* underlying content from showing through on scroll. */
	header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
		padding: var(--space-m) var(--space-l);
		transition: transform 200ms ease;
	}

	/* Hidden on a phone while the page scrolls down. Transform only, so the header keeps its box in the layout and
	   the text below does not jump. The attribute is set from the script, so the compiler cannot see it in the markup. */
	header:global([data-hidden]):not(:focus-within) {
		transform: translateY(-100%);
	}
	/* A header that holds focus is in place at once: the browser scrolls to an off-screen brand before the script shows it. */
	header:focus-within {
		transition: none;
	}
	@media (prefers-reduced-motion: reduce) {
		header {
			transition: none;
		}
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

	/* Brand left, menu right via flex space-between. */
	/* Content width from --shell-width, one value for every route; 720px is only the fallback. */
	.header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		/* At a large text size the brand and the menu wrap onto lines of their own instead of scrolling the page sideways. */
		flex-wrap: wrap;
		row-gap: var(--space-xs);
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
	}

	/* From 600px up the header carries the menu (Timeline, Resources, Settings; Settings appears
	   only when the app is ready or damaged). Below 600px the header is the brand alone and the bottom bar
	   (BottomBar.svelte) is the Primary navigation; About and Feedback live in More and the footer. */
	nav ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
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

	/* Text wordmark, font-weight 600 (no logo until trademark clears). */
	.brand {
		font-weight: 600;
		text-decoration: none;
		color: var(--color-fg);
	}

	/* The same --shell-width as the nav and footer; body content inherits the width. */
	main {
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
		padding: var(--space-l);
		min-height: calc(100vh - 160px);
	}

	/* The Reload button of the replaced-data line: the banner's text-link look and its 44px touch target. */
	[role='status'] button {
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}

	/* Two-line footer content (attribution disclaimer + About/Source links). */
	/* 14px footer text via --font-size-s (set in app.css). */
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

	/* Below 600px (the value header-scroll.ts and BottomBar.svelte repeat; a media query cannot read a variable) the
	   bar replaces the header menu. The page keeps room for both fixed edges: the footer's last line and a focused
	   control scrolled into view stay clear of the bar below, and "Skip to content" lands main below the header. The
	   room above is main's own scroll margin, not the page's scroll padding: the cards and the Timeline set a
	   scroll-margin-top of their own for the chips, and padding would be added on top of it.
	   --bottom-bar-height is the bar's 56px links plus its 1px top border; --header-height is the header's one line
	   (two 16px paddings, one 24px line, 1px border). */
	@media (max-width: 599.98px) {
		:global(:root) {
			--bottom-bar-height: 57px;
			--header-height: 57px;
		}
		:global(html) {
			scroll-padding-bottom: calc(var(--bottom-bar-height) + env(safe-area-inset-bottom));
		}
		main {
			scroll-margin-top: var(--header-height);
		}
		header nav {
			display: none;
		}
		footer {
			padding-bottom: calc(var(--space-l) + var(--bottom-bar-height) + env(safe-area-inset-bottom));
		}
	}
	@media (max-width: 480px) {
		footer {
			padding-bottom: calc(var(--space-m) + var(--bottom-bar-height) + env(safe-area-inset-bottom));
		}
	}
</style>
