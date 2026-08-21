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
	// false so the steps show directly; the Home card hides them behind a "Show me how" disclosure.
	let expanded = $state(false);
</script>

{#if canPrompt}
	<button class="install-action" type="button" onclick={onInstall}>Install</button>
{:else}
	{#if collapsibleSteps}
		<!-- A real disclosure: the trigger persists (focus is never dropped), announces its state via
		     aria-expanded, and controls the steps by id - which stay in the DOM, hidden until opened. -->
		<button
			class="install-action"
			type="button"
			aria-expanded={expanded}
			aria-controls="install-steps"
			onclick={() => (expanded = !expanded)}
		>
			Show me how
		</button>
	{/if}
	<ol id="install-steps" class="install-steps" hidden={collapsibleSteps && !expanded}>
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
		margin: var(--space-s) 0 0;
		padding-left: var(--space-l);
		color: var(--color-fg);
		font-size: var(--font-size-s);
	}

	.install-steps li {
		margin: var(--space-xs) 0;
	}
</style>
