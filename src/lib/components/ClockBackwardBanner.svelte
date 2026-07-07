<script lang="ts">
	type Props = { onfix: () => void };
	let { onfix }: Props = $props();
</script>

<!--
  Backward-clock warning. Presentational + non-blocking: the parent
  (+layout) mounts this only while store.clockBackward is true. NON-DISMISSIBLE by design
  - a wrong clock corrupts every timeline date, so the only ways it clears are
  correcting the device clock or the deliberate "I fixed my clock" reset in Settings (onfix).
  Full-width strip; content centered in the 720px column to align with the header/main.
-->
<div class="clock-banner">
	<div class="clock-banner__inner">
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
		<p class="clock-banner__msg" role="alert">
			Your device clock appears to have moved backward - your timeline dates may be off.
		</p>
		<button class="clock-banner__fix" type="button" onclick={onfix}>Fix this</button>
	</div>
</div>

<style>
	.clock-banner {
		background: var(--color-surface);
		border-left: 3px solid var(--color-danger);
		padding: var(--space-s) var(--space-m);
	}

	.clock-banner__inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-s);
		max-width: 720px;
		margin: 0 auto;
	}

	.clock-banner__icon {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--color-danger);
	}

	.clock-banner__msg {
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
</style>
