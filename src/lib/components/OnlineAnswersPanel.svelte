<script lang="ts">
	import { tick } from 'svelte';
	import { registerSecureInput } from '../profile/lifecycle';

	type Props = {
		defaultMode: 'device' | 'online';
		synthesisEnabled: boolean;
		/** Whether a BYO key is currently stored (presence only; the raw key is never surfaced here). */
		hasKey: boolean;
		onSetDefaultMode: (m: 'device' | 'online') => void;
		onToggleSynthesis: (on: boolean) => void;
		/** Rejects when the key could not be stored; the panel says so. */
		onSaveKey: (key: string) => Promise<void>;
		/** Rejects when the key could not be removed; the panel says so. */
		onClearKey: () => Promise<void>;
	};
	let {
		defaultMode,
		synthesisEnabled,
		hasKey,
		onSetDefaultMode,
		onToggleSynthesis,
		onSaveKey,
		onClearKey
	}: Props = $props();

	// Held only long enough to save; cleared on save. The live input is also registered below so a
	// relock scrub wipes any typed-but-unsaved key from the DOM (the JS draft dies with the component).
	let keyDraft = $state('');

	// Register the key input's DOM node so freezeRelock -> scrubSecureInputs clears any typed-but-unsaved
	// key on relock - the single highest-value cleartext input, matching the EAOS field. Cleanup on unmount.
	let keyInputEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (keyInputEl) return registerSecureInput(keyInputEl);
	});

	let keyError = $state<string | null>(null);

	// The draft is cleared before the save is awaited: the raw key must not linger in the field. A failed save
	// therefore says to enter it again.
	async function save(): Promise<void> {
		const key = keyDraft.trim();
		if (key === '') return;
		keyError = null;
		keyDraft = '';
		try {
			await onSaveKey(key);
		} catch {
			keyError = 'Could not save your key - please enter it again.';
		}
	}

	async function clear(press: MouseEvent): Promise<void> {
		keyError = null;
		try {
			await onClearKey();
		} catch {
			keyError = 'Could not update right now - please try again.';
			return;
		}
		// Remove goes with the key; focus goes to the field a new key is typed in, unless the person already moved it. Not
		// after a tap or a click (detail 1+): a focused text field would open a phone's keyboard. A keyboard or a screen
		// reader presses with detail 0.
		await tick();
		if (!press.detail && document.activeElement === document.body) keyInputEl?.focus();
	}
</script>

<section class="online-section" aria-labelledby="online-heading">
	<h2 id="online-heading" class="online-section__heading">Online answers</h2>
	<p class="online-hint">
		Online mode searches the official library on our server - only your question is sent, never your
		profile or timeline. On-device mode keeps everything on your device after a one-time download.
	</p>

	<div class="online-row">
		<span class="online-label">Default answer mode</span>
		<div class="online-mode" role="group" aria-label="Default answer mode">
			<button
				class="online-mode__opt"
				aria-pressed={defaultMode === 'online'}
				type="button"
				onclick={() => onSetDefaultMode('online')}>Online</button
			>
			<button
				class="online-mode__opt"
				aria-pressed={defaultMode === 'device'}
				type="button"
				onclick={() => onSetDefaultMode('device')}>On device</button
			>
		</div>
	</div>

	<div class="online-synth">
		<label class="online-synth__label">
			<input
				class="online-synth__toggle"
				type="checkbox"
				checked={synthesisEnabled}
				onchange={(e) => onToggleSynthesis(e.currentTarget.checked)}
			/>
			<span>Add an AI-written summary above the sources (uses your own API key)</span>
		</label>
	</div>

	<div class="online-key">
		<label class="online-label" for="online-key-input">Your Anthropic API key</label>
		<div class="online-key__row">
			<input
				id="online-key-input"
				bind:this={keyInputEl}
				class="online-key__input"
				type="password"
				bind:value={keyDraft}
				placeholder={hasKey ? 'A key is stored' : 'sk-ant-...'}
				autocomplete="off"
			/>
			<button class="online-key__save" type="button" onclick={save}>Save</button>
			{#if hasKey}
				<button class="online-key__clear" type="button" onclick={clear}>Remove</button>
			{/if}
		</div>
		{#if keyError}
			<p class="online-key__error" role="alert">{keyError}</p>
		{/if}
		<p class="online-hint">
			Your key is encrypted on this device and sent only to Anthropic - never to us.
			<a href="https://console.anthropic.com/settings/keys" rel="external noopener">
				Where do I get a key?
			</a>
		</p>
		<details class="online-key__protect">
			<summary>How is my key protected?</summary>
			<ul>
				<li>
					Stored encrypted (AES-GCM) in your browser, alongside your other private data - never in
					plain text.
				</li>
				<li>
					Sent straight to Anthropic when you ask; your browser is set to block it from going
					anywhere else.
				</li>
				<li>It never reaches our servers - we can't see, store, or use it.</li>
				<li>Remove it any time with the button above.</li>
			</ul>
		</details>
	</div>
</section>

<style>
	.online-section {
		margin-top: var(--space-l);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}
	.online-section__heading {
		margin: 0 0 var(--space-m);
	}
	.online-hint {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.online-label {
		display: block;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		margin-bottom: var(--space-s);
	}
	.online-row {
		margin-top: var(--space-m);
	}
	/* As on the theme pills: the ends are rounded on the end buttons, not clipped, so the tap area below is not cut. */
	.online-mode {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: 999px;
	}
	.online-mode__opt:first-child {
		border-radius: 999px 0 0 999px;
	}
	.online-mode__opt:last-child {
		border-radius: 0 999px 999px 0;
	}
	/* A 44 px tap target with the pill's look unchanged (WCAG 2.5.5). */
	.online-mode__opt {
		position: relative;
	}
	.online-mode__opt::after {
		content: '';
		position: absolute;
		inset: calc(50% - 22px) 0;
	}
	/* The keyboard focus ring sits on the container, outset, so it follows the whole pill's rounded ends (an inset
	   per-segment ring would lose its corners on the end buttons). The accent fill still marks which segment is
	   active. WCAG 2.4.7. */
	.online-mode:has(:focus-visible) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.online-mode__opt {
		background: transparent;
		color: var(--color-fg-muted);
		border: none;
		padding: 6px 15px;
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.online-mode__opt[aria-pressed='true'] {
		background: var(--color-accent);
		color: var(--color-bg);
	}
	/* As on the theme pills: forced colors drop the fill, so a 3px Highlight border marks the chosen mode, with the
	   padding giving up those 3px so the button keeps its size. */
	@media (forced-colors: active) {
		.online-mode__opt[aria-pressed='true'] {
			border: 3px solid Highlight;
			padding: 3px 12px;
			border-radius: 999px;
		}
	}
	.online-synth {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}
	.online-synth__label {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.online-key {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}
	.online-key__row {
		display: flex;
		gap: var(--space-s);
		margin-bottom: var(--space-s);
	}
	.online-key__error {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}
	.online-key__input {
		flex: 1;
		/* min-width:0 so the flex input can shrink instead of overflowing the row at narrow widths
		   (a flex item's default min-width:auto is the input's intrinsic content width). */
		min-width: 0;
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
		font: inherit;
	}
	.online-key__save,
	.online-key__clear {
		background: none;
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.online-key__clear {
		color: var(--color-danger);
		border-color: var(--color-danger);
	}
	.online-key__protect {
		margin-top: var(--space-s);
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.online-key__protect summary {
		color: var(--color-accent);
		cursor: pointer;
	}
	.online-key__protect ul {
		margin: var(--space-s) 0 0;
		padding-left: var(--space-l);
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
</style>
