<script lang="ts">
	import type { AnswerView } from '$lib/ask/answer/answer-view';
	let { view }: { view: AnswerView } = $props();

	// Tier 2. Collapsed by default: the point of the short answer is that it is short.
	let expanded = $state(false);
</script>

{#if view.kind === 'extractive'}
	<section class="ask-answer" aria-label="Answer">
		<!-- The 38 CFR note sits ABOVE the quotation, so the boundary is read before the text it qualifies.
		     The answer itself is the document's own words, which cannot adjudicate the reader's facts - the
		     note is what says so out loud. -->
		{#if view.eligibilityBanner}
			<p class="ask-answer__eligibility">
				This is general information, not a determination of your eligibility. For your specific
				situation, contact an
				<a href="https://www.va.gov/ogc/apps/accreditation/index.asp" rel="external noopener">
					accredited VSO
				</a>.
			</p>
		{/if}
		<p class="ask-answer__label">In short</p>
		<!-- The document's own words, interpolated as plain text. No model wrote this, so there is no
		     fabricated-link risk to defend against here - but a URL or phone number printed in the source
		     still must not become clickable, which plain interpolation and the app-wide
		     format-detection:telephone=no meta together guarantee. -->
		<!-- Expanding SWAPS the short answer for the full passage rather than appending it. The passage
		     already contains the selected sentences, so appending printed them twice inside one block. -->
		<p class="ask-answer__text">{expanded ? view.answer.passage : view.answer.text}</p>
		<p class="ask-answer__src">
			From {view.answer.sourceTitle}{view.answer.page !== undefined
				? ` - p. ${view.answer.page}`
				: ''}
		</p>
		<!-- Offered only when there is genuinely more to show; an expand control that reveals the same
		     sentences again is a dead button. -->
		{#if view.answer.passage !== view.answer.text}
			<button class="ask-answer__more" type="button" onclick={() => (expanded = !expanded)}>
				{expanded ? 'Show less' : 'More detail'}
			</button>
		{/if}
	</section>
{:else if view.kind === 'synthesized'}
	<section class="ask-answer" aria-label="AI-generated summary">
		<p class="ask-answer__label">AI summary</p>
		<!-- Plain-text interpolation: prose is auto-escaped, so a URL the model wrote stays inert; a phone
		     number is kept inert by the app-wide format-detection:telephone=no meta (iOS would otherwise
		     auto-link it). The only links on this surface are the verified citations below. -->
		<p class="ask-answer__text">{view.answer.text}</p>
		{#if view.answer.citations.length > 0}
			<ul class="ask-answer__sources">
				{#each view.answer.citations as c (c.id)}
					<li><a href={c.url} rel="external noopener">{c.title}</a></li>
				{/each}
			</ul>
		{/if}
		<p class="ask-answer__disclaimer">{view.answer.disclaimer}</p>
	</section>
{:else if view.kind === 'notCovered'}
	<section class="ask-answer ask-answer--info" aria-label="Not covered by these sources">
		<p class="ask-answer__text">
			Ask 214 only answers from the official documents it carries, and none of them cover this. That
			is a limit of what is in here, not an answer to your question.
		</p>
		<p class="ask-answer__sources">
			<a href="https://www.va.gov/" rel="external noopener">Search va.gov</a>
			or call the VA benefits hotline at 1-800-827-1000.
		</p>
	</section>
	<!-- Explicit rather than a bare {:else}: a future AnswerView kind must render NOTHING here, not this
	     banner. Svelte cannot check template exhaustiveness, and the wrong fallback would put a specific
	     legal statement under an answer it was never written for. -->
{:else if view.kind === 'eligibility'}
	<section class="ask-answer ask-answer--info" aria-label="General information">
		<p class="ask-answer__text">
			This is general information, not a determination of your eligibility. For help with your
			specific situation, contact an accredited VSO or visit va.gov.
		</p>
		<p class="ask-answer__sources">
			<a href="https://www.va.gov/ogc/apps/accreditation/index.asp" rel="external noopener">
				Find an accredited VSO
			</a>
		</p>
	</section>
{/if}

<style>
	/* Structure only; palette from app tokens. The accent-left card marks it as the answer block that sits
	   ABOVE the unchanged result cards. */
	.ask-answer {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 4px solid var(--color-accent);
		border-radius: var(--radius-m);
		padding: var(--space-l);
		margin-bottom: var(--space-l);
	}
	.ask-answer__label {
		font-size: var(--font-size-s);
		font-weight: 600;
		color: var(--color-accent);
		margin: 0 0 var(--space-s);
	}
	.ask-answer__text {
		/* The model emits 2-3 short paragraphs separated by blank lines. Without this the whole answer
		   renders as one run-on block - never seen, because no answer had ever rendered. */
		white-space: pre-line;
		margin: 0 0 var(--space-m);
	}
	.ask-answer__eligibility {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		border-bottom: 1px solid var(--color-border);
		margin: 0 0 var(--space-m);
		padding-bottom: var(--space-s);
	}
	.ask-answer__src {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-s);
	}
	.ask-answer__more {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: var(--font-size-s);
		color: var(--color-accent);
		cursor: pointer;
		text-decoration: underline;
	}
	.ask-answer__sources {
		margin: 0 0 var(--space-m);
		padding-left: var(--space-l);
	}
	.ask-answer__disclaimer {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0;
	}
</style>
