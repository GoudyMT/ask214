<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import AppGate from '$lib/components/AppGate.svelte';
	import { setProfileApp, type ProfileApp } from '$lib/profile/context';
	import { initProfileApp } from '$lib/profile/app-init';
	import { createProfileStore } from '$lib/profile/store.svelte';
	import { checkBrowserSupport } from '$lib/crypto/capability';
	import { openMtcDb } from '$lib/db/schema';
	import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
	import { safeLog } from '$lib/log/safelog';

	let { children } = $props();

	// App-wide profile container, set synchronously (setContext must run during component
	// init). Populated by the client-only app-init in onMount below. The shell renders for
	// every status except `unsupported`; store-dependent UI reads `app.store` once ready.
	const app = $state<ProfileApp>({ status: 'loading', store: null, cause: null });
	setProfileApp(app);

	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
		}

		// Client-only: IndexedDB + crypto are browser-only. Store created bus-less here;
		// L2b adds the cross-tab bus + lifecycle/idle wiring.
		void initProfileApp({
			checkSupport: checkBrowserSupport,
			openDb: () => openMtcDb(),
			bootstrap: bootstrapLocalKeystore,
			createStore: (db) => createProfileStore(db)
		})
			.then((result) => {
				if (result.status === 'unsupported') {
					app.cause = result.cause;
					app.status = 'unsupported';
				} else {
					app.store = result.store;
					app.status = 'ready';
				}
			})
			.catch(() => {
				// Hard init failure past the capability gate (e.g. a tampered keystore failing
				// load()). Opaque log only (no PII). The app shell stays usable; a dedicated
				// init-error / recovery surface is deferred to v1.1 (see Settings "Wipe" L5).
				safeLog({ code: 'E_INIT_FAILED' });
			});
	});
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<meta name="theme-color" content="#0f1419" />
	<meta name="color-scheme" content="dark light" />
</svelte:head>

<AppGate {app}>
	<a class="skip-link" href="#main-content">Skip to content</a>

	<header>
		<nav aria-label="Primary">
			<a href={resolve('/')} class="brand">Transition Companion</a>
			<ul>
				<li><a href={resolve('/about')}>About</a></li>
			</ul>
		</nav>
	</header>

	<main id="main-content">
		{@render children()}
	</main>

	<footer>
		<p>
			Independent open-source project. Not affiliated with the US Department of Defense, the
			Department of Veterans Affairs, or any branch of the US military.
		</p>
		<p>
			<a href={resolve('/about')}>About</a> &middot;
			<a href="https://github.com/GoudyMT/military-transition-companion" rel="external">Source</a>
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

	/* Lock #2: right-aligned nav (brand left, nav right) via flex space-between. */
	/* Lock #1: 720px content container; 1024px wider variant ships when a */
	/* dashboard/timeline route lands (Phase 2+). */
	nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 720px;
		margin: 0 auto;
	}

	/* Lock #7: inline horizontal nav for Phase 1 (2 items: brand + About). */
	/* Migrate to bottom-tab-bar pattern when nav reaches 4+ items. */
	nav ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		gap: var(--space-m);
	}

	/* Lock #3: text wordmark, font-weight 600 (no logo until trademark clears). */
	.brand {
		font-weight: 600;
		text-decoration: none;
		color: var(--color-fg);
	}

	/* Lock #1 + #9: 720px content container; body content inherits the same width. */
	main {
		max-width: 720px;
		margin: 0 auto;
		padding: var(--space-l);
		min-height: calc(100vh - 160px);
	}

	/* Lock #5: 2-line footer content (attribution disclaimer + About/Source links). */
	/* Lock #6: 14px footer text via --font-size-s (already shipped via app.css). */
	footer {
		max-width: 720px;
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
