<script lang="ts">
	import { EXAMPLE_QUESTIONS } from '$lib/ask/example-questions';

	let { onPick }: { onPick: (question: string) => void } = $props();

	// The user can stop the auto-scroll (WCAG 2.2.2). Hover/focus pause is CSS-driven (added with the
	// motion); this button is the persistent stop, and `paused` gates the animation via the wrapper class.
	let paused = $state(false);
</script>

<div class="q-feed" class:q-feed--paused={paused}>
	<div class="q-feed__mask">
		<ul class="q-feed__track" aria-label="Example questions">
			{#each EXAMPLE_QUESTIONS as q (q)}
				<li>
					<button class="q-feed__pill" type="button" onclick={() => onPick(q)}>{q}</button>
				</li>
			{/each}
		</ul>
	</div>
	<button class="q-feed__pause" type="button" onclick={() => (paused = !paused)}>
		{paused ? 'Play' : 'Pause'}
	</button>
</div>

<style>
	/* Base = a static, edge-faded, manually-scrollable row (works for everyone, on-brand). The
	   auto-scroll is layered on with the motion pass and is OFF under prefers-reduced-motion. Pills
	   are muted pill-outline, matching the retired static example chips. */
	.q-feed {
		margin-top: var(--space-m);
	}
	.q-feed__mask {
		overflow-x: auto;
		scrollbar-width: none;
		-webkit-mask-image: linear-gradient(to right, transparent, #000 10%, #000 90%, transparent);
		mask-image: linear-gradient(to right, transparent, #000 10%, #000 90%, transparent);
	}
	.q-feed__mask::-webkit-scrollbar {
		display: none;
	}
	.q-feed__track {
		display: inline-flex;
		gap: var(--space-s);
		list-style: none;
		margin: 0;
		padding: var(--space-xs) 0;
	}
	.q-feed__pill {
		white-space: nowrap;
		font-size: var(--font-size-s);
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: none;
		color: var(--color-fg-muted);
		cursor: pointer;
	}
	.q-feed__pill:hover {
		color: var(--color-fg);
		border-color: var(--color-fg-muted);
	}
	.q-feed__pause {
		display: block;
		margin: var(--space-s) auto 0;
		font-size: var(--font-size-s);
		padding: 2px var(--space-m);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		color: var(--color-fg-muted);
		cursor: pointer;
	}
</style>
