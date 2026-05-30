<script lang="ts">
	type Props = { onfix: () => void };
	let { onfix }: Props = $props();
	let dismissed = $state(false);
</script>

<!--
  Backward-clock warning (master spec 5.6). Presentational + non-blocking: the parent
  (app-init/layout) mounts this only when the store's clockBackward signal is true, and
  wires `onfix` to the Settings "I fixed my clock" reset. Session-dismissible here; a
  reload remounts -> it reappears until the clock is fixed (spec 5.6 persistence).
-->
{#if !dismissed}
	<div class="clock-banner">
		<svg class="clock-banner__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M12 3 1.5 21h21L12 3Zm0 5.5v6m0 3.25v.01"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		<p class="clock-banner__msg" role="status">
			Your device clock appears to have moved backward - your timeline dates may be off.
		</p>
		<button class="clock-banner__fix" type="button" onclick={onfix}>Fix this</button>
		<button
			class="clock-banner__dismiss"
			type="button"
			aria-label="Dismiss"
			onclick={() => (dismissed = true)}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<path
					d="M6 6 18 18M18 6 6 18"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
				/>
			</svg>
		</button>
	</div>
{/if}

<style>
	.clock-banner {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		background: var(--color-surface);
		border-left: 3px solid var(--color-danger);
		padding: var(--space-s) var(--space-m);
	}

	.clock-banner__icon {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--color-danger);
	}

	.clock-banner__msg {
		flex: 1;
		margin: 0;
		color: var(--color-fg);
	}

	.clock-banner__fix {
		flex: none;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}

	.clock-banner__dismiss {
		flex: none;
		display: inline-flex;
		padding: var(--space-xs);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		cursor: pointer;
	}

	.clock-banner__dismiss svg {
		width: 1rem;
		height: 1rem;
	}
</style>
