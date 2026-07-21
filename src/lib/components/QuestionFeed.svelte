<script lang="ts">
	import { onMount } from 'svelte';
	import { EXAMPLE_QUESTIONS } from '$lib/ask/example-questions';

	let { onPick }: { onPick: (question: string) => void } = $props();

	let maskEl = $state<HTMLDivElement>();

	// The drift is wired in onMount, after the bound element exists. Position accumulates in a JS float
	// and is WRITTEN to scrollLeft (reading it back loses the sub-pixel step - the browser rounds
	// scrollLeft to an integer, so a ~0.4px/frame nudge rounds to 0 forever). It pauses on hover/focus,
	// and yields to any real user scroll (touch-drag / wheel), detected by comparing scrollLeft against
	// the value the drift last wrote - so a native touch scroll is not fought - resuming ~1s after the
	// user stops. Fully static under prefers-reduced-motion. The second (aria-hidden) pill set is the
	// wrap target: at one set's width we subtract it, so the loop has no seam.
	onMount(() => {
		const mask = maskEl;
		if (!mask) return;
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

		let hovering = false;
		let pos = 0;
		let written = 0;
		let userScrolledAt = -Infinity;
		const RESUME_MS = 1000;
		const SPEED_PX_PER_S = 24;

		const hold = (): void => {
			hovering = true;
		};
		const release = (): void => {
			hovering = false;
		};
		const onScroll = (): void => {
			if (Math.abs(mask.scrollLeft - written) > 2) {
				pos = mask.scrollLeft;
				userScrolledAt = performance.now();
			}
		};
		mask.addEventListener('pointerenter', hold);
		mask.addEventListener('pointerleave', release);
		mask.addEventListener('focusin', hold);
		mask.addEventListener('focusout', release);
		mask.addEventListener('scroll', onScroll, { passive: true });

		let raf = 0;
		let last = 0;
		const tick = (t: number): void => {
			if (last && !hovering && !reduce.matches && t - userScrolledAt > RESUME_MS) {
				pos += (SPEED_PX_PER_S * (t - last)) / 1000;
				const oneSet = mask.scrollWidth / 2;
				if (oneSet > 0 && pos >= oneSet) pos -= oneSet;
				mask.scrollLeft = pos;
				written = mask.scrollLeft;
			}
			last = t;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);

		return () => {
			cancelAnimationFrame(raf);
			mask.removeEventListener('pointerenter', hold);
			mask.removeEventListener('pointerleave', release);
			mask.removeEventListener('focusin', hold);
			mask.removeEventListener('focusout', release);
			mask.removeEventListener('scroll', onScroll);
		};
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
</div>

<style>
	/* A native scroll row (touch-drag + wheel work), edge-faded, with a JS scrollLeft drift for the
	   auto-scroll. Pills are muted pill-outline, matching the retired static example chips. */
	.q-feed {
		margin-top: var(--space-m);
	}
	/* pan-x: horizontal drags scroll this row; vertical gestures fall through to page scroll. */
	.q-feed__mask {
		overflow-x: auto;
		touch-action: pan-x;
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
</style>
