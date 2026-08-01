<script lang="ts">
	// onReload is injected so the button is unit-testable; the default reloads onto the new bundle.
	type Props = { onReload?: () => void };
	let { onReload = () => location.reload() }: Props = $props();
</script>

<!--
  Cross-tab schema-upgrade takeover. Shown when another tab on a newer bundle upgrades the
  shared database and steps this tab's connection aside - this tab's stored data is no longer
  reachable, so a full-takeover (same slot as the capability hard-stop) offers the one action
  that fixes it: reload onto the new bundle. Neutral tone; this is an update, not an error.
-->
<div class="app-updated">
	<div class="app-updated__card">
		<h1>The app updated in another tab</h1>
		<p>A newer version is ready. Reload this tab to continue.</p>
		<button type="button" onclick={() => onReload()}>Reload</button>
	</div>
</div>

<style>
	.app-updated {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: var(--space-l);
		background: var(--color-bg);
	}

	.app-updated__card {
		max-width: 28rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-xl);
	}

	.app-updated__card h1 {
		margin: 0 0 var(--space-m);
	}

	.app-updated__card p {
		margin: 0 0 var(--space-l);
		color: var(--color-fg);
	}

	.app-updated__card button {
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-l);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.app-updated__card button:hover {
		background: var(--color-accent-muted);
	}
</style>
