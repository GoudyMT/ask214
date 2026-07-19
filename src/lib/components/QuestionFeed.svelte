<script lang="ts">
	import { EXAMPLE_QUESTIONS } from '$lib/ask/example-questions';

	let { onPick }: { onPick: (question: string) => void } = $props();

	// `paused` = the persistent Pause control. `interacting` = a transient pause while the pointer is
	// over the feed or a pill holds focus, so reaching for a pill (hover, touch, or Tab) stops the
	// drift and the target holds still. Auto-scroll runs only when neither holds and motion is allowed.
	let paused = $state(false);
	let interacting = $state(false);
	let maskEl = $state<HTMLDivElement>();

	// Wired here rather than as markup handlers: the row is a plain scroll container and the pills are
	// the controls, so putting pointer handlers in the markup would claim the container is itself
	// interactive. Depends only on the element, so flipping `interacting` does not re-bind these.
	$effect(() => {
		const mask = maskEl;
		if (!mask) return;
		const hold = (): void => {
			interacting = true;
		};
		const release = (): void => {
			interacting = false;
		};
		mask.addEventListener('pointerenter', hold);
		mask.addEventListener('pointerleave', release);
		mask.addEventListener('focusin', hold);
		mask.addEventListener('focusout', release);
		return () => {
			mask.removeEventListener('pointerenter', hold);
			mask.removeEventListener('pointerleave', release);
			mask.removeEventListener('focusin', hold);
			mask.removeEventListener('focusout', release);
		};
	});

	// Auto-advance scrollLeft while idle. Native overflow scrolling stays on, so a touch-drag or wheel
	// scrolls manually; this only nudges the position between interactions. The second (aria-hidden)
	// pill set is the seamless wrap target: at one set's width we subtract it, so the loop has no seam.
	$effect(() => {
		const mask = maskEl;
		if (!mask || paused || interacting) return;
		const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
		if (mq?.matches) return;

		let raf = 0;
		let last = 0;
		const SPEED_PX_PER_S = 24;
		const tick = (t: number): void => {
			if (last) {
				const oneSet = mask.scrollWidth / 2;
				let next = mask.scrollLeft + (SPEED_PX_PER_S * (t - last)) / 1000;
				if (oneSet > 0 && next >= oneSet) next -= oneSet;
				mask.scrollLeft = next;
			}
			last = t;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="q-feed">
	<div class="q-feed__mask" bind:this={maskEl}>
		<ul class="q-feed__track" aria-label="Example questions">
			{#each EXAMPLE_QUESTIONS as q (q)}
				<li>
					<button class="q-feed__pill" type="button" onclick={() => onPick(q)}>{q}</button>
				</li>
			{/each}
			{#each EXAMPLE_QUESTIONS as q, i (i)}
				<li aria-hidden="true">
					<button class="q-feed__pill" type="button" tabindex="-1" aria-hidden="true">{q}</button>
				</li>
			{/each}
		</ul>
	</div>
	<button class="q-feed__pause" type="button" onclick={() => (paused = !paused)}>
		{paused ? 'Play' : 'Pause'}
	</button>
</div>

<style>
	/* A native scroll row (touch-drag + wheel work), edge-faded, with a JS scrollLeft drift for the
	   auto-scroll. Pills are muted pill-outline, matching the retired static example chips. */
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
	/* margin-right (not gap) so two identical sets tile to an exact period - scrollWidth / 2 is then a
	   seamless wrap point. */
	.q-feed__track {
		display: inline-flex;
		list-style: none;
		margin: 0;
		padding: var(--space-xs) 0;
	}
	.q-feed__track li {
		margin-right: var(--space-s);
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
	@media (prefers-reduced-motion: reduce) {
		/* No auto-scroll under reduced motion, so the Pause control has nothing to act on. */
		.q-feed__pause {
			display: none;
		}
	}
</style>
