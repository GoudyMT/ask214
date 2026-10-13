<script lang="ts">
	type Props = { onunlock: () => void; busy?: boolean; error?: string | null };
	let { onunlock, busy = false, error = null }: Props = $props();

	// Not `disabled`: a disabled button that holds focus drops it, so a busy press is ignored instead.
	function press(): void {
		if (!busy) onunlock();
	}
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
	<!-- Lock hands focus here mid-press, so a held Enter's repeats would unlock again: only a new press counts. Space
	     clicks on release, and other held keys (Tab, arrows) must still work. -->
	<button
		class="locked-panel__unlock"
		type="button"
		onclick={press}
		onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
		aria-busy={busy}
	>
		{busy ? 'Unlocking...' : 'Unlock'}
	</button>
	{#if error}<p class="locked-panel__error" role="alert">{error}</p>{/if}
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

	/* The fill dims, not the button: it keeps focus while busy, and a faded focus ring would drop below 3:1. */
	.locked-panel__unlock[aria-busy='true'] {
		background: color-mix(in srgb, var(--color-accent) 60%, var(--color-bg));
		cursor: default;
	}

	.locked-panel__error {
		margin: 0;
		color: var(--color-danger);
	}
</style>
