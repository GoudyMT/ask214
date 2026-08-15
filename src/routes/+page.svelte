<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import AskView from '$lib/components/AskView.svelte';
	import EmbedWorker from '$lib/ask/embed-worker?worker';
	import { createAskStore, createEmbedder, loadCorpus, ASK_ERROR, type AskState } from '$lib/ask';
	import { sourcesFromCorpus, type Source } from '$lib/ask/sources';
	import { getProfileApp } from '$lib/profile/context';
	import { retrieveOnline } from '$lib/ask/online/retrieve-online';
	import { synthesize } from '$lib/ask/synthesis/synthesize';
	import {
		getDefaultMode,
		isOnlineConsented,
		setOnlineConsented,
		isSynthesisEnabled
	} from '$lib/ask/online-prefs';

	const CORPUS_BASE = '/corpus/corpus-v1.0';

	const app = getProfileApp();
	// First-run = a ready, unlocked profile with no persona yet. The on-ramp invites setup; once a
	// timeline exists it is replaced by the returning-user "next deadlines" strip (a later increment).
	const showOnramp = $derived(
		app.status === 'ready' && !app.store?.locked && app.store?.persona.completeness === 'none'
	);

	// Ask store wiring (moved from the old /ask route): the store needs the in-memory corpus, so it is
	// created after the corpus (a small same-origin static asset) loads. The ~23MB model is NOT fetched
	// here - it downloads only when the user opts in (store.setUp), via AskView's setup prompt.
	let store = $state<ReturnType<typeof createAskStore> | null>(null);
	let sources = $state<Map<string, Source>>(new Map());
	let initError = $state(false);

	const askState: AskState = $derived(
		initError ? { kind: 'error', code: ASK_ERROR.CORPUS } : (store?.state ?? { kind: 'idle' })
	);
	const ready = $derived(store !== null);
	// The below-hero band is idle-state content; once a query runs (any non-idle state), the results own
	// the space and the band steps aside.
	const isIdle = $derived(askState.kind === 'idle');

	onMount(() => {
		let worker: Worker | undefined;
		void (async () => {
			try {
				const corpus = await loadCorpus(fetch, CORPUS_BASE);
				sources = sourcesFromCorpus(corpus);
				worker = new EmbedWorker();
				store = createAskStore({
					embed: createEmbedder(worker),
					corpus,
					// Route-bound closures keep fetch, the corpus version, and the raw BYO key out of the store.
					retrieveOnline: (query) =>
						retrieveOnline(query, { fetch, expectedCorpusVersion: corpus.version }),
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
				// The store opens online when capable (the on-ramp default); honor an explicit device choice.
				if (getDefaultMode() === 'device') store.setMode('device');
			} catch {
				initError = true;
			}
		})();
		return () => worker?.terminate();
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
	<h1 class="home-hero">Answers for your military transition, from sources you can trust.</h1>

	<AskView
		{askState}
		{ready}
		{sources}
		onlineCapable={true}
		mode={store?.mode ?? getDefaultMode()}
		showNudge={store?.showNudge ?? false}
		onAsk={(q) => store?.ask(q)}
		onSetUp={() => store?.setUp()}
		onDismiss={() => store?.dismissSetup()}
		onSetMode={(m) => store?.setMode(m)}
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
	/>

	{#if isIdle && showOnramp}
		<hr class="home-divider" />
		<section class="home-onramp" aria-labelledby="home-onramp-heading">
			<h2 id="home-onramp-heading">Make it yours</h2>
			<p>
				Add your separation date and Ask 214 builds a timeline of what to do and when - tailored to
				your date, still fully on your device.
			</p>
			<a class="home-onramp__action" href={resolve('/wizard')}>Set up your timeline</a>
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
</style>
