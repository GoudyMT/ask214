<script lang="ts">
	import type { SynthesisView } from '$lib/ask/synthesis/synthesis-view';
	let { view }: { view: SynthesisView } = $props();
</script>

{#if view.kind === 'answer'}
	<section class="ask-summary" aria-label="AI-generated summary">
		<p class="ask-summary__label">AI summary</p>
		<!-- Plain-text interpolation: prose is auto-escaped and never auto-linked, so any URL/phone the model
		     wrote is inert. The only links on this surface are the verified citations below. -->
		<p class="ask-summary__text">{view.answer.text}</p>
		{#if view.answer.citations.length > 0}
			<ul class="ask-summary__sources">
				{#each view.answer.citations as c (c.id)}
					<li><a href={c.url} rel="external noopener">{c.title}</a></li>
				{/each}
			</ul>
		{/if}
		<p class="ask-summary__disclaimer">{view.answer.disclaimer}</p>
	</section>
{:else if view.kind === 'eligibility'}
	<section class="ask-summary ask-summary--info" aria-label="General information">
		<p class="ask-summary__text">
			This is general information, not a determination of your eligibility. For help with your
			specific situation, contact an accredited VSO or visit va.gov.
		</p>
		<p class="ask-summary__sources">
			<a href="https://www.va.gov/ogc/apps/accreditation/index.asp" rel="external noopener">
				Find an accredited VSO
			</a>
		</p>
	</section>
{:else if view.kind === 'refusal'}
	<section class="ask-summary ask-summary--info" aria-label="Summary unavailable">
		<p class="ask-summary__text">
			We couldn't produce a reliable summary for this one. Please read the official sources below.
		</p>
	</section>
{:else}
	<p class="ask-summary__muted">AI summary unavailable - showing the official sources.</p>
{/if}

<style>
	/* Structure only; palette from app tokens. The accent-left card marks it as the additive summary that
	   sits ABOVE the unchanged result cards (Option B). Final spacing/tone verified at the Visual Checkpoint. */
	.ask-summary {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 4px solid var(--color-accent);
		border-radius: var(--radius-m);
		padding: var(--space-l);
		margin-bottom: var(--space-l);
	}
	.ask-summary__label {
		font-size: var(--font-size-s);
		font-weight: 600;
		color: var(--color-accent);
		margin: 0 0 var(--space-s);
	}
	.ask-summary__text {
		margin: 0 0 var(--space-m);
	}
	.ask-summary__sources {
		margin: 0 0 var(--space-m);
		padding-left: var(--space-l);
	}
	.ask-summary__disclaimer {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0;
	}
	.ask-summary__muted {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-m);
	}
</style>
