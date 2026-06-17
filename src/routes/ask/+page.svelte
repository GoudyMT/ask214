<script lang="ts">
	import { onMount } from 'svelte';
	import AskView from '$lib/components/AskView.svelte';
	import EmbedWorker from '$lib/ask/embed-worker?worker';
	import { createAskStore, createEmbedder, loadCorpus, ASK_ERROR, type AskState } from '$lib/ask';

	const CORPUS_BASE = '/corpus/corpus-v1.0';

	// The store is created once the corpus (a small same-origin static asset) loads - it needs the
	// in-memory Corpus. Until then the input is disabled; a corpus-load failure surfaces as `error`. The
	// ~23MB model is NOT fetched here - it downloads only when the user opts in (store.setUp), per ADR-015.
	let store = $state<ReturnType<typeof createAskStore> | null>(null);
	let initError = $state(false);

	let askState: AskState = $derived(
		initError ? { kind: 'error', code: ASK_ERROR.CORPUS } : (store?.state ?? { kind: 'idle' })
	);
	let ready = $derived(store !== null);

	onMount(() => {
		let worker: Worker | undefined;
		void (async () => {
			try {
				const corpus = await loadCorpus(fetch, CORPUS_BASE);
				worker = new EmbedWorker();
				store = createAskStore({ embed: createEmbedder(worker), corpus });
			} catch {
				initError = true;
			}
		})();
		return () => worker?.terminate();
	});
</script>

<svelte:head><title>Ask</title></svelte:head>

<AskView
	{askState}
	{ready}
	onAsk={(q) => store?.ask(q)}
	onSetUp={() => store?.setUp()}
	onDismiss={() => store?.dismissSetup()}
/>
