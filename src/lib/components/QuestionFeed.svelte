<script lang="ts">
	import { onMount } from 'svelte';
	import { EXAMPLE_QUESTIONS } from '$lib/ask/example-questions';

	let { onPick }: { onPick: (question: string) => void } = $props();

	let maskEl = $state<HTMLDivElement>();
	// A persistent stop for the auto-scroll (WCAG 2.2.2): hover/focus pause is unavailable to a touch
	// user, so this always-present control is their pause. Read live in the drift loop below; toggled by
	// a click (a normal user event, so mutating this $state is safe - unlike a teardown-time flag).
	let paused = $state(false);

	// The drift is wired in onMount, after the bound element exists. Position accumulates in a JS float
	// and is WRITTEN to scrollLeft (reading it back loses the sub-pixel step - the browser rounds
	// scrollLeft to an integer, so a ~0.4px/frame nudge rounds to 0 forever). It pauses on hover/focus,
	// on the pause control, and yields to any real user scroll (touch-drag / wheel), detected by comparing
	// scrollLeft against the value the drift last wrote - so a native touch scroll is not fought - resuming
	// ~1s after the user stops. Fully static under prefers-reduced-motion. The second (aria-hidden) pill
	// set is the wrap target: at one set's width we subtract it, so the loop has no seam.
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
			if (last && !hovering && !paused && !reduce.matches && t - userScrolledAt > RESUME_MS) {
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
	<button
		class="q-feed__pause"
		type="button"
		aria-pressed={paused}
		aria-label={paused ? 'Resume example questions' : 'Pause example questions'}
		onclick={() => (paused = !paused)}
	>
		{#if paused}
			<svg class="q-feed__icon" viewBox="0 0 12 12" aria-hidden="true">
				<path d="M3 1.5 L10 6 L3 10.5 Z" fill="currentColor" />
			</svg>
		{:else}
			<svg class="q-feed__icon" viewBox="0 0 12 12" aria-hidden="true">
				<rect x="2" y="1" width="3" height="10" rx="1" fill="currentColor" />
				<rect x="7" y="1" width="3" height="10" rx="1" fill="currentColor" />
			</svg>
		{/if}
	</button>
</div>

<style>
	/* A native scroll row (touch-drag + wheel work), edge-faded, with a JS scrollLeft drift for the
	   auto-scroll, plus a trailing pause control. Pills are muted pill-outline, matching the retired
	   static example chips. */
	.q-feed {
		margin-top: var(--space-m);
		display: flex;
		align-items: center;
		gap: var(--space-s);
	}
	/* pan-x: horizontal drags scroll this row; vertical gestures fall through to page scroll. */
	.q-feed__mask {
		flex: 1;
		min-width: 0;
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
	/* The loop clones are decorative fillers - keep them from taking pointer clicks (they carry no
	   handler and look identical to the real pills, so a click on one would otherwise do nothing). */
	.q-feed__pill[aria-hidden='true'] {
		pointer-events: none;
	}
	/* Trailing pause control: a 28px tap target, always visible so a touch user can find it, sitting
	   just past the fade rather than in the scrolling row. */
	.q-feed__pause {
		flex: none;
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-fg-muted);
		cursor: pointer;
	}
	.q-feed__pause:hover {
		color: var(--color-fg);
		border-color: var(--color-fg-muted);
	}
	.q-feed__pause:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.q-feed__icon {
		width: 12px;
		height: 12px;
	}
	/* Under reduced motion the row is static, so there is nothing to pause - drop the control. */
	@media (prefers-reduced-motion: reduce) {
		.q-feed__pause {
			display: none;
		}
	}
</style>
