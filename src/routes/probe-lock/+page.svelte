<script lang="ts">
	import { onDestroy } from 'svelte';
	import { KAT_PASSWORD } from '$lib/backup/kdf-kat';
	import { KDF_WORKER_SRC } from '$lib/backup/kdf-paths';

	// A device probe, not a feature: it measures on a real phone what an app PIN would cost and show. Nothing it
	// makes is stored, and nothing leaves the page.
	//
	// 1. One cold key derive per page load, timed from `new Worker` to the key, so the number includes the worker's
	//    fetch and start-up the way a real unlock after a reload would pay them. A second run would reuse a warm
	//    engine and read low, so the button works once; a reload gives a cold page again.
	// 2. Made-up text and an optional plain cover drawn when the page is hidden, to see what the phone's recent-apps
	//    view keeps.
	// 3. One PIN field with the attributes the app lock would use, to see whether the phone offers to save it, what
	//    the keyboards suggest over it, and what a screen reader says.

	const SALT_BYTES = 16;

	type Result = {
		ms: number;
		firstProgressMs: number | null;
		startState: DocumentVisibilityState;
		stayedVisible: boolean;
		outcome: string;
	};

	let used = $state(false);
	let running = $state(false);
	let result = $state<Result | null>(null);
	let coverOnHide = $state(false);
	let covered = $state(false);
	let pin = $state('');

	function runOnce(): void {
		if (used) return;
		used = true;
		running = true;
		const startState = document.visibilityState;
		let stayedVisible = startState === 'visible';
		const onVisibility = (): void => {
			if (document.visibilityState !== 'visible') stayedVisible = false;
		};
		document.addEventListener('visibilitychange', onVisibility);
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		const pass = new TextEncoder().encode(KAT_PASSWORD).buffer;
		let firstProgressMs: number | null = null;
		let done = false;

		const started = performance.now();
		const worker = new Worker(KDF_WORKER_SRC, { type: 'module' });
		const finish = (outcome: string): void => {
			if (done) return;
			done = true;
			const ms = Math.round(performance.now() - started);
			worker.terminate();
			document.removeEventListener('visibilitychange', onVisibility);
			result = { ms, firstProgressMs, startState, stayedVisible, outcome };
			running = false;
		};
		worker.onmessage = (event: MessageEvent<{ type?: unknown; code?: unknown }>) => {
			const data = event.data;
			if (data.type === 'progress') {
				firstProgressMs ??= Math.round(performance.now() - started);
				return;
			}
			if (data.type === 'key') finish('key made');
			else if (data.type === 'error')
				finish(typeof data.code === 'string' ? data.code : 'E_NO_CODE');
		};
		worker.onerror = () => finish('E_WORKER_ERROR');
		worker.postMessage({ op: 'derive', purpose: 'restore', pass, salt }, [pass]);
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === 'hidden') {
			pin = '';
			if (coverOnHide) covered = true;
		} else {
			covered = false;
		}
	}

	function refuse(event: ClipboardEvent): void {
		event.preventDefault();
	}

	onDestroy(() => {
		pin = '';
	});
</script>

<svelte:document onvisibilitychange={onVisibilityChange} />
<svelte:window onpagehide={() => (pin = '')} />

<svelte:head>
	<title>Lock probe - Ask 214</title>
</svelte:head>

<h1>Lock probe</h1>
<p class="note">A test page for one phone. Nothing here is saved or sent.</p>

<section aria-labelledby="derive-heading">
	<h2 id="derive-heading">1. Key timing</h2>
	<button type="button" class="primary" onclick={runOnce} disabled={used}>Run once</button>
	{#if running}
		<p role="status">Working...</p>
	{:else if result}
		<dl class="result" data-testid="probe-result">
			<dt>Time</dt>
			<dd data-testid="probe-ms">{result.ms} ms</dd>
			<dt>First progress</dt>
			<dd data-testid="probe-first">
				{result.firstProgressMs === null ? 'none' : `${result.firstProgressMs} ms`}
			</dd>
			<dt>Page at start</dt>
			<dd>{result.startState}</dd>
			<dt>Stayed on screen</dt>
			<dd>{result.stayedVisible ? 'yes' : 'no - run again after a reload'}</dd>
			<dt>Result</dt>
			<dd data-testid="probe-outcome">{result.outcome}</dd>
		</dl>
	{/if}
	{#if used && !running}
		<p class="note">Reload the page for the next run.</p>
	{/if}
</section>

<section aria-labelledby="canary-heading">
	<h2 id="canary-heading">2. Recent apps</h2>
	<p class="canary">PROBE CANARY 7Q4X: made-up text for this test.</p>
	<label class="toggle">
		<input type="checkbox" bind:checked={coverOnHide} />
		Cover on hide
	</label>
</section>

<section aria-labelledby="pin-heading">
	<h2 id="pin-heading">3. PIN field</h2>
	<label class="pin-label" for="probe-pin">PIN</label>
	<input
		id="probe-pin"
		class="pin"
		type="password"
		inputmode="numeric"
		autocomplete="one-time-code"
		spellcheck="false"
		bind:value={pin}
		oncopy={refuse}
		oncut={refuse}
	/>
	<button type="button" class="primary" onclick={() => (pin = '')}>Unlock</button>
</section>

{#if covered}
	<div class="cover" aria-hidden="true"></div>
{/if}

<style>
	section {
		margin: 0 0 var(--space-xl);
	}
	.note {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.result {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-xs) var(--space-m);
	}
	.result dd {
		margin: 0;
		font-weight: 600;
	}
	.canary {
		font-size: var(--font-size-l);
		font-weight: 600;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: var(--space-s);
	}
	.pin-label {
		display: block;
		margin-bottom: var(--space-xs);
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.pin {
		width: 10ch;
		padding: var(--space-s);
		font: inherit;
		letter-spacing: 0.3em;
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
	}
	.primary {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
	}
	.primary:disabled {
		opacity: 0.6;
	}
	.cover {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: var(--color-bg);
	}
</style>
