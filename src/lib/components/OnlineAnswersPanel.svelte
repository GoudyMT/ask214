<script lang="ts">
	type Props = {
		defaultMode: 'device' | 'online';
		synthesisEnabled: boolean;
		/** Whether a BYO key is currently stored (presence only; the raw key is never surfaced here). */
		hasKey: boolean;
		onSetDefaultMode: (m: 'device' | 'online') => void;
		onToggleSynthesis: (on: boolean) => void;
		onSaveKey: (key: string) => void;
		onClearKey: () => void;
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

	// Held only long enough to save; cleared on save so a typed secret never lingers in component state.
	let keyDraft = $state('');

	function save(): void {
		const key = keyDraft.trim();
		if (key === '') return;
		onSaveKey(key);
		keyDraft = '';
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
				class="online-key__input"
				type="password"
				bind:value={keyDraft}
				placeholder={hasKey ? 'A key is stored' : 'sk-ant-...'}
				autocomplete="off"
			/>
			<button class="online-key__save" type="button" onclick={save}>Save</button>
			{#if hasKey}
				<button class="online-key__clear" type="button" onclick={onClearKey}>Remove</button>
			{/if}
		</div>
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
	.online-mode {
		display: flex;
		gap: var(--space-xs);
	}
	.online-mode__opt {
		background: var(--color-bg);
		color: var(--color-fg-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		padding: var(--space-xs) var(--space-m);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.online-mode__opt[aria-pressed='true'] {
		background: var(--color-accent);
		color: var(--color-bg);
		border-color: var(--color-accent);
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
	.online-key__input {
		flex: 1;
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
