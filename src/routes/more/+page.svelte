<script module lang="ts">
	// In the module, not the page: it must survive a trip to Feedback and back, which mounts this page again and finds
	// the remembered page already read by Feedback.
	let cameFrom = '/more';
</script>

<script lang="ts">
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { stashRoute } from '#lib/feedback/context.js';
	import { getProfileApp } from '#lib/profile/context.js';

	const app = getProfileApp();
	// The header's rule: Settings is offered when the app is ready, and when damaged (its erase is the way back).
	const showSettings = $derived(app.status === 'ready' || app.status === 'damaged');

	// Feedback is sent with the page the person was on. More is not a page feedback can name, so arriving here
	// remembers the page they came from. Arriving from More itself or from Feedback keeps that page, and a direct open
	// (no earlier page; "/more" is not a known route) clears a stale name.
	afterNavigate(({ from }) => {
		const path = from?.url.pathname;
		if (path !== '/more' && path !== '/feedback') cameFrom = path ?? '/more';
		stashRoute(cameFrom);
	});
	// The remembered page belongs to one visit: leaving for anything but Feedback forgets it.
	beforeNavigate(({ to }) => {
		if (to?.url.pathname !== '/feedback') stashRoute((cameFrom = '/more'));
	});
</script>

<svelte:head>
	<title>More - Ask 214</title>
</svelte:head>

<h1>More</h1>

{#if showSettings}
	<ul class="group">
		<li>
			<a class="row" href={resolve('settings')}>
				<span class="row__title">Settings</span>
				<span class="row__text">Your dates, backup, theme, online answers</span>
			</a>
		</li>
	</ul>
{/if}

<ul class="group">
	<li>
		<a class="row" href={resolve('resources')}>
			<span class="row__title">Resources</span>
			<span class="row__text">Official links for benefits, jobs and school</span>
		</a>
	</li>
	<li>
		<a class="row" href={resolve('documents')}>
			<span class="row__title">Documents</span>
			<span class="row__text">Guides saved for offline</span>
		</a>
	</li>
</ul>

<ul class="group">
	<li>
		<a class="row" href={resolve('feedback')}>
			<span class="row__title">Feedback</span>
			<span class="row__text">Tell us what to fix or add</span>
		</a>
	</li>
	<li>
		<a class="row" href={resolve('about')}>
			<span class="row__title">About</span>
			<span class="row__text">Sources, privacy, how Ask 214 works</span>
		</a>
	</li>
	<li>
		<a class="row" href="https://github.com/GoudyMT/ask214" rel="external">
			<span class="row__title">Source code</span>
			<span class="row__text">On GitHub</span>
		</a>
	</li>
</ul>

<p class="more-note">
	New tools land here first. A tool moves to the bottom bar only once people use it a lot.
</p>

<style>
	.group {
		list-style: none;
		margin: 0 0 var(--space-m);
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		overflow: hidden;
	}
	.group li + li {
		border-top: 1px solid var(--color-border);
	}

	.row {
		display: block;
		padding: var(--space-m);
		text-decoration: none;
	}
	/* Inside the clipped box, so the focus ring is drawn inward instead of being cut off. */
	.row:focus-visible {
		outline-offset: -2px;
	}
	.row__title {
		display: block;
		color: var(--color-fg);
		font-weight: 600;
	}
	.row__text {
		display: block;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.more-note {
		margin: var(--space-l) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
</style>
