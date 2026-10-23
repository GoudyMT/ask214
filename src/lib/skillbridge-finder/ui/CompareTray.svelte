<script lang="ts">
	type Props = { count: number; oncompare: () => void };
	let { count, oncompare }: Props = $props();
</script>

<!-- Fixed above the bottom bar so the picks stay in reach while the list scrolls; the page shows it only with a pick. -->
<div class="tray">
	<span class="tray__count">{count} of 3 picked</span>
	<button class="tray__compare" type="button" onclick={oncompare}>Compare</button>
</div>

<style>
	.tray {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--bottom-bar-height, 0px) + env(safe-area-inset-bottom));
		z-index: 10;
		box-sizing: border-box;
		max-width: var(--shell-width, 720px);
		margin: 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-m);
		padding: var(--space-s) var(--space-m);
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
	}

	.tray__count {
		font-weight: 600;
		font-size: var(--font-size-s);
	}

	.tray__compare {
		min-height: 44px;
		padding: 0 var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.tray__compare:hover {
		background: var(--color-accent-muted);
	}

	@media (forced-colors: active) {
		.tray__compare {
			border: 1px solid ButtonText;
		}
	}
</style>
