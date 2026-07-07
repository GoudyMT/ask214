<script lang="ts">
	import type { CapabilityCause } from '../crypto/capability';

	type Props = { cause: CapabilityCause };
	let { cause }: Props = $props();
</script>

<!--
  Hard-stop capability-failure screen. Full-takeover (the layout renders
  ONLY this when the bootstrap capability gate fails - no polyfill, no fallback, no in-app
  action). Neutral/informational tone (capability mismatch, not user error); the
  specific cause is preserved but demoted to a muted technical-detail line.
-->
<div class="unsupported">
	<div class="unsupported__card">
		<h1>This browser can't run the app securely</h1>
		<p>
			This app keeps your information private and encrypted on your device, and this browser doesn't
			support what that needs. Please use a recent version of:
		</p>
		<ul class="unsupported__browsers">
			<li>Chrome 116+</li>
			<li>Safari 17+</li>
			<li>Edge 116+</li>
		</ul>
		<p class="unsupported__detail">Technical detail: {cause}</p>
	</div>
</div>

<style>
	.unsupported {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: var(--space-l);
		background: var(--color-bg);
	}

	.unsupported__card {
		max-width: 28rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-xl);
	}

	.unsupported__card h1 {
		margin: 0 0 var(--space-m);
	}

	.unsupported__card p {
		margin: 0 0 var(--space-m);
		color: var(--color-fg);
	}

	.unsupported__browsers {
		margin: 0 0 var(--space-l);
		padding-left: var(--space-l);
		color: var(--color-fg);
	}

	.unsupported__detail {
		margin: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
</style>
