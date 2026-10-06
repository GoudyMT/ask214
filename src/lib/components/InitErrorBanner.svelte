<script lang="ts">
	import { resolve } from '$app/paths';

	// onReload is injected so the button is unit-testable; the default reloads the page.
	type Props = { damaged?: boolean; onReload?: () => void };
	let { damaged = false, onReload = () => location.reload() }: Props = $props();
</script>

<!--
  Start-up failure. The shell stays: Ask, About and Documents need no saved data, so this sits in the clock warning's
  slot, under the header, instead of covering the app. Two kinds:
  - Damaged saved data (it failed the app's own checks): a reload reads the same bytes, so the banner points to the
    erase in Settings, the only way back. The link is a fixed path.
  - Anything else - an app older than its database (a newer release raised the version), an open another tab blocks,
    a storage error: Reload. It fixes the version case once the device is online (pages load network-first; offline,
    or after a rollback, the older page comes back), and the blocked case once the other tab closes.
-->
<div class="init-banner">
	<div class="init-banner__inner">
		<svg class="init-banner__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M12 3 1.5 21h21L12 3Zm0 5.5v6m0 3.25v.01"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		{#if damaged}
			<p class="init-banner__msg" role="alert">
				The information saved on this device can't be read. You can erase it in <a
					href={resolve('/settings')}>Settings</a
				> and start again.
			</p>
		{:else}
			<p class="init-banner__msg" role="alert">
				The app couldn't open the information saved on this device. Reload to try again.
			</p>
			<button class="init-banner__reload" type="button" onclick={() => onReload()}>Reload</button>
		{/if}
	</div>
</div>

<style>
	/* The clock warning's look (ClockBackwardBanner): a full-width strip, content in the 720px column. */
	.init-banner {
		background: var(--color-surface);
		border-left: 3px solid var(--color-danger);
		padding: var(--space-s) var(--space-m);
	}

	.init-banner__inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-s);
		max-width: 720px;
		margin: 0 auto;
	}

	.init-banner__icon {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		color: var(--color-danger);
	}

	.init-banner__msg {
		margin: 0;
		color: var(--color-fg);
	}

	.init-banner__msg a {
		color: var(--color-accent);
	}

	/* min-height: the 44px touch target the list's and Settings' buttons use; the text-link look stays. */
	.init-banner__reload {
		flex: none;
		min-height: 44px;
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
