<script lang="ts">
	import InstallPrompt from './InstallPrompt.svelte';

	// The Home surface: a dismissible card that steers a browser-tab user to install, so their local
	// data lands in the storage WebKit keeps out of the eviction path. Presentational; the Home route
	// decides when to show it (uninstalled + not dismissed) and supplies the install + dismiss actions.
	let {
		canPrompt,
		onInstall,
		ondismiss
	}: {
		canPrompt: boolean;
		onInstall: () => void;
		ondismiss: () => void;
	} = $props();
</script>

<section class="install-nudge" aria-labelledby="install-nudge-heading">
	<button class="install-nudge__dismiss" type="button" aria-label="Dismiss" onclick={ondismiss}>
		&times;
	</button>
	<h2 id="install-nudge-heading" class="install-nudge__heading">
		{canPrompt ? 'Install Ask 214' : 'Keep Ask 214 on your Home Screen'}
	</h2>
	<p class="install-nudge__body">
		Add it to your device so it opens like an app and your saved data stays put on this device.
	</p>
	<InstallPrompt {canPrompt} {onInstall} collapsibleSteps />
</section>

<style>
	/* Matches the SetupCTA surface-card idiom, with an accent left-border so it reads as a calm
	   suggestion rather than the danger-coloured clock banner. */
	.install-nudge {
		position: relative;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}

	.install-nudge__dismiss {
		position: absolute;
		top: var(--space-s);
		right: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
		padding: var(--space-xs) var(--space-s);
	}

	.install-nudge__dismiss:hover {
		color: var(--color-fg);
	}

	.install-nudge__heading {
		margin: 0 var(--space-l) var(--space-s) 0;
		font-size: var(--font-size-l);
	}

	.install-nudge__body {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
</style>
