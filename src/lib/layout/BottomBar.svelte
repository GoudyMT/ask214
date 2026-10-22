<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { tabForPath, type Tab } from './tab-for-path';

	// Each icon is one hand-drawn path in a 24 px box, drawn with the text colour so the current tab's accent
	// reaches it. More is three filled dots, so its path is filled as well as stroked.
	const TABS: {
		tab: Tab;
		route: '/' | '/timeline' | '/skillbridge' | '/more';
		label: string;
		d: string;
		filled: boolean;
	}[] = [
		{
			tab: 'home',
			route: '/',
			label: 'Home',
			d: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
			filled: false
		},
		{
			tab: 'timeline',
			route: '/timeline',
			label: 'Timeline',
			d: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4',
			filled: false
		},
		{
			tab: 'skillbridge',
			route: '/skillbridge',
			label: 'SkillBridge',
			d: 'M2 14h20M4 14a8 6 0 0 1 16 0M8 8.8V14M12 8v6M16 8.8V14M6 14v6M18 14v6',
			filled: false
		},
		{
			tab: 'more',
			route: '/more',
			label: 'More',
			d: 'M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
			filled: true
		}
	];

	const current = $derived(tabForPath(page.url.pathname));
</script>

<nav class="bottom-bar" aria-label="Primary">
	<ul>
		{#each TABS as t (t.tab)}
			<li>
				<a href={resolve(t.route as '/')} aria-current={current === t.tab ? 'page' : undefined}>
					<svg
						viewBox="0 0 24 24"
						width="24"
						height="24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.75"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
						focusable="false"
					>
						<path d={t.d} fill={t.filled ? 'currentColor' : undefined} />
					</svg>
					<span>{t.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	/* A phone-only bar: from 600px the header menu takes over, and only one Primary landmark is ever displayed.
	   The media query cannot read a variable, so the same 599.98px stands in the layout's styles. */
	.bottom-bar {
		display: none;
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 10;
		background: var(--color-bg);
		border-top: 1px solid var(--color-border);
		padding-bottom: env(safe-area-inset-bottom);
	}
	@media (max-width: 599.98px) {
		.bottom-bar {
			display: block;
		}
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
	}

	a {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-height: 56px;
		/* The 3px every tab but the current one takes as padding is where the current tab's top bar sits, so no tab
		   moves when the mark changes. A transparent border would do the same, but forced colours draw it. */
		padding-top: 3px;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		line-height: 1.2;
		text-decoration: none;
	}
	a[aria-current='page'] {
		padding-top: 0;
		border-top: 3px solid var(--color-accent);
		color: var(--color-accent);
		font-weight: 600;
	}
</style>
