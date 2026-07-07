<script lang="ts">
	type Props = { onunlock: () => void; busy?: boolean };
	let { onunlock, busy = false }: Props = $props();
</script>

<!--
  Locked-state panel. Presentational: a PII surface (e.g. Settings) renders
  this when store.locked is true and wires onunlock to a re-load (load() re-decrypts from the
  local key; no passphrase in v1.0). Shared app-wide PII-surface pattern, defined here once.
-->
<section class="locked-panel" aria-labelledby="locked-heading">
	<h2 id="locked-heading">Your data is locked</h2>
	<p class="locked-panel__body">
		Your information is encrypted on this device. Unlock to view and edit it.
	</p>
	<button class="locked-panel__unlock" type="button" onclick={onunlock} disabled={busy}>
		{busy ? 'Unlocking...' : 'Unlock'}
	</button>
</section>

<style>
	.locked-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
		text-align: center;
	}

	.locked-panel h2 {
		margin: 0;
	}

	.locked-panel__body {
		margin: 0;
		color: var(--color-fg-muted);
	}

	/* Primary CTA: filled accent + bg-colored text. */
	.locked-panel__unlock {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.locked-panel__unlock:hover {
		background: var(--color-accent-muted);
	}

	.locked-panel__unlock:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
