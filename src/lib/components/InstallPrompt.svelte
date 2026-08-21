<script lang="ts">
	// The shared install action for both surfaces (the Home nudge and the Settings control). Where the
	// browser exposes a captured beforeinstallprompt (Android / desktop) it offers a one-tap Install;
	// where it does not (iOS Safari) it shows the manual Add-to-Home-Screen steps. The host owns the
	// heading, copy, and chrome; this owns only the action.
	let {
		canPrompt,
		onInstall,
		collapsibleSteps = false
	}: {
		canPrompt: boolean;
		onInstall: () => void;
		collapsibleSteps?: boolean;
	} = $props();

	// Whether the user has opened the iOS steps in the Home card. Settings passes collapsibleSteps
	// false so the steps show directly; the Home card hides them behind a "Show me how" toggle.
	let expanded = $state(false);
	const showSteps = $derived(!collapsibleSteps || expanded);
</script>

{#if canPrompt}
	<button class="install-action" type="button" onclick={onInstall}>Install</button>
{:else if !showSteps}
	<button class="install-action" type="button" onclick={() => (expanded = true)}>Show me how</button
	>
{:else}
	<ol class="install-steps">
		<li>Tap the Share button in your browser toolbar.</li>
		<li>Choose "Add to Home Screen".</li>
		<li>Open Ask 214 from your Home Screen.</li>
	</ol>
{/if}

<style>
	.install-action {
		display: inline-block;
		background: var(--color-accent);
		color: var(--color-bg);
		padding: var(--space-s) var(--space-l);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.install-action:hover {
		background: var(--color-accent-muted);
	}

	.install-steps {
		margin: 0;
		padding-left: var(--space-l);
		color: var(--color-fg);
		font-size: var(--font-size-s);
	}

	.install-steps li {
		margin: var(--space-xs) 0;
	}
</style>
