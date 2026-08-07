<script lang="ts">
	import type { AskState } from '$lib/ask/types';
	import type { Source } from '$lib/ask/sources';
	import AskResultCard from './AskResultCard.svelte';
	import SourceReader from './SourceReader.svelte';
	import QuestionFeed from './QuestionFeed.svelte';
	import CrisisCard from './CrisisCard.svelte';
	import AskSummary from './AskSummary.svelte';

	let {
		askState,
		ready,
		onAsk,
		onSetUp,
		onDismiss,
		sources,
		onlineCapable = false,
		mode = 'device',
		onSetMode = () => {},
		onConsentOnline = () => {},
		showNudge = false,
		onDismissNudge = () => {},
		onOfferDevice = () => {},
		onRetryOnline = () => {}
	}: {
		askState: AskState;
		ready: boolean;
		onAsk: (query: string) => void;
		onSetUp: () => void;
		onDismiss: () => void;
		sources: Map<string, Source>;
		onlineCapable?: boolean;
		mode?: 'device' | 'online';
		onSetMode?: (m: 'device' | 'online') => void;
		onConsentOnline?: () => void;
		showNudge?: boolean;
		onDismissNudge?: () => void;
		onOfferDevice?: (query: string) => void;
		onRetryOnline?: (query: string) => void;
	} = $props();

	let query = $state('');
	let showSimilar = $state(false);
	let setupDismissed = $state(false); // a [Not now] happened this view -> nudge with the reminder
	let inputEl: HTMLInputElement | undefined = $state();
	let openSource = $state<Source | null>(null); // the source shown in the offline reader modal, or null

	// The reminder dismissal persists for the tab session (non-PII: just "user hid the Ask download
	// nudge" - no query, no profile). Plain sessionStorage is fine here (the encrypted-IDB rule governs PII, not this).
	const REMINDER_DISMISSED_KEY = 'mtc:ask:reminder-dismissed';
	let reminderDismissed = $state(
		typeof sessionStorage !== 'undefined' && sessionStorage.getItem(REMINDER_DISMISSED_KEY) === '1'
	);
	const showReminder = $derived(askState.kind === 'idle' && setupDismissed && !reminderDismissed);
	// A query is in flight: freeze the mode controls so a mid-flight switch can't land the result under the
	// other mode's privacy line (both the toggle and the nudge's button change egress mode).
	const inFlight = $derived(askState.kind === 'embedding' || askState.kind === 'modelLoading');

	function submit() {
		if (query.trim() !== '') onAsk(query);
	}

	// A feed pill behaves exactly like typing the question + Search: fill the visible input, then run
	// it through the same ask path (so the first query still hits the one-time model opt-in).
	function pick(q: string) {
		query = q;
		onAsk(q);
	}
	function skipSetup() {
		setupDismissed = true;
		onDismiss();
	}
	function dismissReminder() {
		reminderDismissed = true;
		if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(REMINDER_DISMISSED_KEY, '1');
	}
	// "Read full source" -> open the offline reader on the source this card cites (the corpus holds its text).
	function readSource(sourceId: string) {
		openSource = sources.get(sourceId) ?? null;
	}
</script>

{#if showReminder}
	<div class="ask-reminder">
		<span>Want to set up Ask and keep planning offline? One-time ~45 MB.</span>
		<span class="ask-reminder__actions">
			<button class="ask-reminder__set" type="button" onclick={() => inputEl?.focus()}
				>Set up</button
			>
			<button class="ask-reminder__x" type="button" aria-label="Dismiss" onclick={dismissReminder}
				>&times;</button
			>
		</span>
	</div>
{/if}

{#if showNudge}
	<div class="ask-reminder">
		<span
			>Prefer to keep everything on your device? Set up on-device answers - fully private, works
			offline.</span
		>
		<span class="ask-reminder__actions">
			<button
				class="ask-reminder__set"
				type="button"
				disabled={inFlight}
				onclick={() => onSetMode('device')}>On-device</button
			>
			<button class="ask-reminder__x" type="button" aria-label="Dismiss" onclick={onDismissNudge}
				>&times;</button
			>
		</span>
	</div>
{/if}

<form
	class="ask-bar"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<input
		bind:this={inputEl}
		bind:value={query}
		class="ask-input"
		placeholder="Ask about benefits, SkillBridge, VA health care..."
		disabled={!ready}
		aria-label="Ask a question"
	/>
	<button class="ask-search" type="submit" disabled={!ready}>Search</button>
</form>

{#if onlineCapable}
	<div class="ask-mode" role="group" aria-label="Answer mode">
		<button
			class="ask-mode__opt"
			aria-pressed={mode === 'online'}
			type="button"
			disabled={inFlight}
			onclick={() => onSetMode('online')}>Online</button
		>
		<button
			class="ask-mode__opt"
			aria-pressed={mode === 'device'}
			type="button"
			disabled={inFlight}
			onclick={() => onSetMode('device')}>On device</button
		>
	</div>
{/if}

<p class="ask-private" class:ask-private--online={onlineCapable && mode === 'online'}>
	{#if onlineCapable && mode === 'online'}
		Answered online - only your question is sent; your profile and data stay on your device.
	{:else}
		Answered on your device - nothing you type is sent to a server or shared.
	{/if}
</p>

<!-- aria-live so a screen reader hears the answer / "no match" / "online unavailable" / AI summary arrive
     (WCAG 4.1.3). On the crisis branch the wrapper drops aria-live so the CrisisCard's stronger
     role="alert" (assertive) is not nested inside a polite live region. -->
<div class="ask-result" aria-live={askState.kind === 'crisis' ? undefined : 'polite'}>
	{#if askState.kind === 'idle'}
		<QuestionFeed onPick={pick} />
	{:else if askState.kind === 'needsSetup'}
		<div class="ask-setup">
			<h2 class="ask-setup__title">One-time setup to answer your question</h2>
			<p class="ask-setup__query">"{askState.pendingQuery}"</p>
			<p class="ask-setup__body">
				To answer your question, Ask downloads a one-time search tool (about 45 MB). After that it's
				instant and works fully offline.
			</p>
			<div class="ask-setup__actions">
				<button class="ask-setup__go" type="button" onclick={onSetUp}>Set up &amp; answer</button>
				<button class="ask-setup__skip" type="button" onclick={skipSetup}>Not now</button>
			</div>
		</div>
	{:else if askState.kind === 'needsReconsent'}
		<div class="ask-msg ask-msg--accent">
			<p class="ask-msg__title">Answer online?</p>
			<p class="ask-msg__body">
				Your question is sent to our server to search the official library - never your profile or
				timeline, which stay on your device. You can switch to fully on-device answers any time.
			</p>
			<div class="ask-setup__actions">
				<button class="ask-setup__go" type="button" onclick={onConsentOnline}>Use online</button>
				<button class="ask-setup__skip" type="button" onclick={() => onSetMode('device')}
					>Stay on device</button
				>
			</div>
		</div>
	{:else if askState.kind === 'modelLoading'}
		<div class="ask-msg ask-msg--accent">
			<p class="ask-msg__title"><span class="ask-spinner"></span>Setting up Ask</p>
			<p class="ask-msg__body">
				Downloading the search tool (about 45 MB), one time only - then answering your question.
				Afterwards Ask is instant and works offline.
			</p>
		</div>
	{:else if askState.kind === 'embedding'}
		<div class="ask-msg">
			<p class="ask-msg__body"><span class="ask-spinner"></span>Finding relevant sources...</p>
		</div>
	{:else if askState.kind === 'results'}
		{@const cards = askState.cards}
		{#if askState.summary}
			<AskSummary view={askState.summary} />
		{/if}
		<p class="ask-count">Top match</p>
		<AskResultCard
			card={cards[0]!}
			variant="lead"
			onReadSource={() => readSource(cards[0]!.sourceId)}
		/>
		{#if cards.length > 1}
			<button class="ask-toggle" type="button" onclick={() => (showSimilar = !showSimilar)}>
				{showSimilar ? 'Hide' : `Show ${cards.length - 1}`} similar sources
			</button>
			{#if showSimilar}
				<div class="ask-similar">
					{#each cards.slice(1) as c, i (i)}
						<AskResultCard card={c} variant="compact" onReadSource={() => readSource(c.sourceId)} />
					{/each}
				</div>
			{/if}
		{/if}
	{:else if askState.kind === 'empty'}
		<div class="ask-msg">
			<p class="ask-msg__title">No close match</p>
			<p class="ask-msg__body">Try rephrasing your question, or ask about something else.</p>
		</div>
	{:else if askState.kind === 'offline'}
		<div class="ask-msg ask-msg--accent">
			<p class="ask-msg__title">You're offline</p>
			<p class="ask-msg__body">
				Connect to the internet once to set up Ask (about 45 MB). After that it works fully offline.
			</p>
		</div>
	{:else if askState.kind === 'error'}
		<div class="ask-msg ask-msg--warn">
			<p class="ask-msg__title">Something went wrong</p>
			<p class="ask-msg__body">The search couldn't run. Please try again.</p>
		</div>
	{:else if askState.kind === 'degraded'}
		{@const q = askState.query}
		<div class="ask-msg ask-msg--warn">
			{#if askState.rung === 'offer_device'}
				<p class="ask-msg__title">Online is unavailable right now</p>
				<p class="ask-msg__body">You can answer this question fully on your device instead.</p>
				<button class="ask-setup__go" type="button" onclick={() => onOfferDevice(q)}
					>Answer on your device</button
				>
			{:else if askState.rung === 'offer_online'}
				<p class="ask-msg__title">That didn't work</p>
				<button class="ask-setup__go" type="button" onclick={() => onRetryOnline(q)}
					>Try online</button
				>
			{:else}
				<p class="ask-msg__title">We couldn't answer that right now</p>
				<p class="ask-msg__body">
					Try the official tools directly: <a href="https://www.va.gov/" rel="external noopener"
						>va.gov</a
					>.
				</p>
			{/if}
		</div>
	{:else if askState.kind === 'crisis'}
		<CrisisCard />
	{/if}
</div>

<SourceReader source={openSource} onClose={() => (openSource = null)} />

<style>
	.ask-private {
		font-size: var(--font-size-s);
		color: var(--color-success);
		margin: var(--space-s) 0 0;
		text-align: center;
	}
	/* Online copy is muted, not the on-device success green - it states egress honestly, without a
	   reassuring tone the online path has not earned. */
	.ask-private--online {
		color: var(--color-fg-muted);
	}

	/* Mode switch by the bar: always-visible transparency over whether the next question egresses. */
	.ask-mode {
		display: flex;
		gap: var(--space-xs);
		justify-content: center;
		margin-top: var(--space-s);
	}
	.ask-mode__opt {
		background: var(--color-surface);
		color: var(--color-fg-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-xs) var(--space-m);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.ask-mode__opt[aria-pressed='true'] {
		background: var(--color-accent);
		color: var(--color-bg);
		border-color: var(--color-accent);
	}
	/* Frozen while a query is in flight (a mid-flight switch would mislabel the completing result). */
	.ask-mode__opt:disabled,
	.ask-reminder__set:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.ask-bar {
		display: flex;
		gap: var(--space-s);
	}
	.ask-input {
		flex: 1;
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: 12px var(--space-m);
		font: inherit;
	}
	/* Hovering hints the bar is live; focusing promotes it to the accent border + ring, which then
	   HOLDS for the whole typing session (focus does not lapse while the user types). */
	.ask-input:hover:not(:focus) {
		border-color: var(--color-fg-muted);
	}
	.ask-input:focus {
		outline: 2px solid var(--color-accent);
		border-color: var(--color-accent);
	}
	.ask-input:disabled {
		opacity: 0.6;
	}
	.ask-search {
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		padding: 0 var(--space-l);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.ask-search:hover:not(:disabled) {
		background: var(--color-accent-muted);
	}
	.ask-search:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.ask-result {
		margin-top: var(--space-l);
		text-align: left;
	}
	.ask-count {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-s);
	}

	.ask-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-s);
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
		margin: var(--space-m) 0 var(--space-s);
	}

	.ask-msg {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-l);
	}
	.ask-msg--accent {
		border-left: 4px solid var(--color-accent);
	}
	.ask-msg--warn {
		border-left: 4px solid var(--color-danger);
	}
	.ask-msg__title {
		font-weight: 600;
		margin: 0 0 var(--space-xs);
	}
	.ask-msg__body {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0;
	}

	.ask-setup {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}
	.ask-setup__title {
		font-size: var(--font-size-l);
		margin: 0 0 var(--space-s);
	}
	.ask-setup__query {
		color: var(--color-fg);
		background: var(--color-bg);
		border-left: 3px solid var(--color-accent);
		padding: var(--space-s) var(--space-m);
		border-radius: var(--radius-s);
		margin: 0 0 var(--space-m);
		font-size: var(--font-size-s);
	}
	.ask-setup__body {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		margin: 0 0 var(--space-m);
	}
	.ask-setup__actions {
		display: flex;
		gap: var(--space-s);
		align-items: center;
		flex-wrap: wrap;
	}
	.ask-setup__go {
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		padding: 10px var(--space-l);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.ask-setup__skip {
		background: none;
		color: var(--color-fg-muted);
		border: none;
		padding: 10px var(--space-m);
		font: inherit;
		cursor: pointer;
	}

	.ask-reminder {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
		margin-top: var(--space-m);
		/* Match the gap below the banner to the ask-bar's own input<->Search gap so the banner never
		   sits flush on the boxes below it. */
		margin-bottom: var(--space-s);
		font-size: var(--font-size-s);
	}
	.ask-reminder__actions {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		white-space: nowrap;
	}
	.ask-reminder__set {
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		font-weight: 600;
		cursor: pointer;
	}
	.ask-reminder__x {
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font-size: var(--font-size-base);
		line-height: 1;
		cursor: pointer;
	}

	.ask-spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		margin-right: var(--space-s);
		vertical-align: -1px;
		animation: ask-spin 0.8s linear infinite;
	}
	@keyframes ask-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
