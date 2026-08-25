<script lang="ts">
	import { routeLabel, type FeedbackInput, type KnownRoute } from '$lib/feedback/types';

	let {
		attachedRoute = null,
		submit
	}: {
		attachedRoute?: KnownRoute | null;
		submit: (input: FeedbackInput) => Promise<{ ok: boolean }>;
	} = $props();

	let message = $state('');
	let includePage = $state(true);
	let replyEmail = $state('');
	let phase = $state<'idle' | 'submitting' | 'success' | 'error'>('idle');
	let showEmpty = $state(false);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (message.trim() === '') {
			showEmpty = true;
			return;
		}
		showEmpty = false;
		phase = 'submitting';
		const input: FeedbackInput = {
			message,
			route: includePage ? attachedRoute : null,
			replyEmail: replyEmail || null
		};
		const res = await submit(input).catch(() => ({ ok: false }));
		phase = res.ok ? 'success' : 'error';
	}

	function reset() {
		message = '';
		replyEmail = '';
		includePage = true;
		phase = 'idle';
		showEmpty = false;
	}
</script>

{#if phase === 'success'}
	<div class="panel" role="status">
		<h2>Thanks - your feedback was sent.</h2>
		<p>I read every message. If you left an email, I'll get back to you.</p>
		<button type="button" class="btn" onclick={reset}>Send another</button>
	</div>
{:else if phase === 'error'}
	<div class="panel err" role="alert">
		<h2>That didn't send.</h2>
		<p>
			Something went wrong on our end - your message wasn't lost, it just didn't reach me. Try
			again, or email me directly at <a href="mailto:feedback@ask214.com">feedback@ask214.com</a>.
		</p>
		<button type="button" class="btn" onclick={() => (phase = 'idle')}>Try again</button>
	</div>
{:else}
	<form onsubmit={handleSubmit}>
		<div class="field">
			<label for="fb-msg">Your message</label>
			<textarea id="fb-msg" bind:value={message} placeholder="What happened, or what would help?"
			></textarea>
			{#if showEmpty}<p class="err-hint">Please enter a message.</p>{/if}
		</div>

		{#if attachedRoute}
			<div class="field attached">
				<input type="checkbox" id="fb-ctx" bind:checked={includePage} />
				<label for="fb-ctx">
					Include the page I was on (<span class="route">{routeLabel(attachedRoute)}</span>) - just
					the page name, nothing personal
				</label>
			</div>
		{/if}

		<div class="field">
			<label for="fb-email">Your email <span class="opt">(optional)</span></label>
			<input id="fb-email" type="email" bind:value={replyEmail} placeholder="you@example.com" />
			<p class="hint">Only if you'd like a reply. Leave it blank to stay anonymous.</p>
		</div>

		<p class="privacy">
			Your message goes to the developer's inbox and is not stored on our servers. Please don't
			include sensitive personal details.
		</p>

		<button type="submit" class="btn" disabled={phase === 'submitting'}>
			{phase === 'submitting' ? 'Sending...' : 'Send feedback'}
		</button>
	</form>
{/if}

<style>
	.field {
		margin: var(--space-l) 0;
	}
	.field label {
		display: block;
		font-weight: 500;
		margin-bottom: var(--space-xs);
	}
	.hint {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: var(--space-xs) 0 0;
	}
	.opt {
		font-weight: 400;
		color: var(--color-fg-muted);
	}
	textarea,
	input[type='email'] {
		width: 100%;
		font: inherit;
		color: var(--color-fg);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		padding: var(--space-s) var(--space-m);
	}
	textarea:focus,
	input[type='email']:focus {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
		border-color: var(--color-accent);
	}
	textarea {
		min-height: 130px;
		resize: vertical;
	}
	.attached {
		display: flex;
		gap: var(--space-s);
		align-items: flex-start;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		padding: var(--space-m);
	}
	.attached label {
		margin: 0;
		font-weight: 400;
	}
	.attached input {
		margin-top: 3px;
		accent-color: var(--color-accent);
		width: 16px;
		height: 16px;
		flex: none;
	}
	.route {
		font-weight: 600;
	}
	.privacy {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		border-left: 2px solid var(--color-border);
		padding: var(--space-xs) 0 var(--space-xs) var(--space-m);
		margin: var(--space-l) 0;
	}
	.err-hint {
		color: var(--color-danger);
		font-size: var(--font-size-s);
		margin: var(--space-xs) 0 0;
	}
	.btn {
		font: inherit;
		font-weight: 500;
		cursor: pointer;
		background: var(--color-accent);
		color: var(--color-bg);
		border: 1px solid transparent;
		border-radius: var(--radius-s);
		padding: var(--space-s) var(--space-l);
	}
	.btn:hover {
		background: var(--color-accent-muted);
	}
	.btn[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	.panel {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		background: var(--color-surface);
		padding: var(--space-l);
	}
	.panel.err {
		border-color: var(--color-danger);
	}
	.panel h2 {
		margin-top: 0;
	}
</style>
