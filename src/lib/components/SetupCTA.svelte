<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<!--
  Shared profile-setup CTA. One element, identical copy in every
  context (Home re-engagement prompt + feature-route empty state) so it cannot leak
  which route the user is on. Presentational; the parent positions it.
-->
<section class="setup-cta" aria-labelledby="setup-cta-heading">
	<h2 id="setup-cta-heading">Set up your profile</h2>
	<p>Add your separation date to get a timeline built around your transition.</p>
	<a class="setup-cta__action" href={resolve('/wizard')}>Get started</a>
</section>

<style>
	.setup-cta {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}

	.setup-cta h2 {
		margin: 0 0 var(--space-s);
	}

	.setup-cta p {
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-l);
	}

	.setup-cta__action {
		display: inline-block;
		background: var(--color-accent);
		color: var(--color-bg);
		padding: var(--space-s) var(--space-l);
		border-radius: var(--radius-m);
		font-weight: 600;
		text-decoration: none;
	}

	.setup-cta__action:hover {
		background: var(--color-accent-muted);
	}
</style>
