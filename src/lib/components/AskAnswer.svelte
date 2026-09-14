<script lang="ts">
	import { tick } from 'svelte';
	import type { AnswerView } from '$lib/ask/answer/answer-view';
	let {
		view,
		onOpenSource
	}: {
		view: AnswerView;
		// Opens the offline reader on the document this answer was quoted from, highlighting the exact
		// passage. Without it the answer block was a dead end: the only reachable "read source" control
		// belonged to the result card, and the answer block had no way into the document it quotes.
		onOpenSource?: (sourceId: string, chunkId?: string) => void;
	} = $props();

	// Tier 2. Collapsed by default: the point of the short answer is that it is short.
	let expanded = $state(false);
	let passageEl = $state<HTMLElement | null>(null);

	// The revealed passage sits BEFORE this control in reading order, because the control lives in the
	// action row beneath the text. A screen-reader user who presses it and continues forward therefore
	// reaches the source line and the legal note - never the passage they asked for. Moving focus onto
	// the passage closes that without reordering the visual layout.
	//
	// On OPEN only. Closing leaves focus on the button, which is where the reader already is and where
	// the next press belongs; yanking it elsewhere on collapse would be the more annoying bug.
	function toggleExpanded(): void {
		expanded = !expanded;
		if (!expanded) return;
		// After the `hidden` flip has landed - a hidden element cannot take focus.
		void tick().then(() => passageEl?.focus());
	}
</script>

{#if view.kind === 'extractive'}
	<section class="ask-answer" aria-label="What the source says">
		<!-- Not "In short". This block renders the opening of the lead card's passage, and measured end to
		     end on the device path it contains the answer to the question asked 39.3% of the time - nowhere
		     near enough to assert it AS the answer, which is why the label describes the block instead of
		     claiming it. It says what this actually is: the document's own words.
		     It neither beats nor loses to the result card below, because it renders that card's own
		     passage: both sit at 39.3%, and the two-tier experience reaches 40.7% once the reader taps
		     through. Regenerate with `pnpm answer-gate`; the online path's figures are currently unmeasured
		     (its gate floors are self-declared stale). -->
		<p class="ask-answer__label">What the source says</p>
		<!-- The document's own words, interpolated as plain text. No model wrote this, so there is no
		     fabricated-link risk to defend against here - but a URL or phone number printed in the source
		     still must not become clickable, which plain interpolation and the app-wide
		     format-detection:telephone=no meta together guarantee. -->
		<!-- A real disclosure, matching the pattern the rest of the app uses (InstallPrompt, CalendarPanel,
		     TaskCard): both tiers stay in the DOM and are toggled with `hidden`, so the trigger can own them
		     by id via aria-controls and announce its state. Swapping one paragraph's text instead would
		     leave the control unannounced and re-read the whole passage into the live region.
		     The passage already contains the selected sentences, so only one is ever shown. -->
		<p class="ask-answer__text" id="ask-answer-short" hidden={expanded}>{view.answer.text}</p>
		<p
			class="ask-answer__text"
			id="ask-answer-passage"
			bind:this={passageEl}
			tabindex="-1"
			hidden={!expanded}
		>
			{view.answer.passage}
		</p>
		<!-- The section heading is the ANTECEDENT of the sentence above it on these VA pages - "If you've
		     completed 2 or more qualifying periods of active duty" scopes "you may qualify for a maximum of
		     48 months". stripHeadingEcho removes it from the answer text, and the result card below shows it
		     only as muted metadata, so without this line the condition is severed from the claim it governs
		     and the block reads as an unconditional determination. -->
		<p class="ask-answer__src">
			From {view.answer.sourceTitle}{view.answer.section !== undefined
				? ` - ${view.answer.section}`
				: ''}{view.answer.page !== undefined ? ` - p. ${view.answer.page}` : ''}
		</p>
		<!-- Offered only when there is genuinely more to show; an expand control that reveals the same
		     sentences again is a dead button. -->
		<div class="ask-answer__actions">
			{#if view.answer.passage !== view.answer.text}
				<button
					class="ask-answer__more"
					type="button"
					aria-expanded={expanded}
					aria-controls="ask-answer-short ask-answer-passage"
					onclick={toggleExpanded}
				>
					{expanded ? 'Show less' : 'More detail'}
				</button>
			{/if}
			<!-- The third tier. The reader already renders the whole document offline with the cited passage
			     highlighted; the answer just never had a way in. It opens on the source the answer was taken
			     FROM. -->
			{#if onOpenSource && view.answer.chunkId}
				{@const answer = view.answer}
				<button
					class="ask-answer__more"
					type="button"
					onclick={() => onOpenSource(answer.sourceId, answer.chunkId)}
				>
					Read it in the source
				</button>
			{/if}
		</div>
		<!-- A synthesis did not reach the reader. Shown only when synthesis was ENABLED, so the default user
		     - for whom the toggle is off - sees nothing. It is a note on the one answer, not a second block
		     competing to BE the answer.
		     The three cases say different things, and the difference is what makes them honest. `refused`
		     CAN claim an attempt: a summary was produced and a safety gate rejected it. `unavailable`
		     CANNOT, because the store reaches it both when the call failed AND when there was no API key to
		     call with - the route collapses those into one `degraded` result, so a sentence like "could not
		     be produced" would be plainly false for the reader who simply never supplied a key. It states
		     the fact it can actually support: that no summary is here. `suppressed` is the 38 CFR case: a
		     summary WAS produced and we dropped it because the question asks about the reader's own
		     eligibility. Neither of the other two can say that without being false about the reason, and a
		     reader who supplied a key and got no summary is owed the reason that actually applied. -->
		{#if view.synthesisNote}
			<p class="ask-answer__note-synthesis">
				{view.synthesisNote === 'refused'
					? 'An AI summary was produced but did not pass our accuracy checks, so the document is quoted instead.'
					: view.synthesisNote === 'suppressed'
						? 'No AI summary is shown on questions about your own eligibility. The document is quoted instead.'
						: 'No AI summary is shown for this answer.'}
			</p>
		{/if}
		<!-- PERMANENT, not conditional on the eligibility gate. That gate reads the QUESTION's phrasing, so
		     it misses "can I use VA health care" - which renders "You're eligible for VA health care" - and
		     fires on procedural lookups that need no warning. This block is always a quotation from an
		     official document and therefore never a determination about the reader, so the line is a
		     standing description rather than a warning, and it cannot under-fire. The destination is the
		     repo's canonical one (resources.ts): VSO claim help is free, while the OGC accreditation search
		     also lists attorneys and agents who may charge. -->
		<p class="ask-answer__note">
			General information, not a determination of your eligibility.
			<a href="https://www.va.gov/get-help-from-accredited-representative/" rel="external noopener">
				Find an accredited VSO
			</a>
		</p>
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
					<li>
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a>
					</li>
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
	.ask-answer__note-synthesis {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: var(--space-s) 0 0;
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
		/* Printed URLs are real document content and stay in the text, so an unbreakable 100+ char token
		   must wrap instead of pushing the block wider than the viewport. 90 corpus chunks carry a run over
		   40 chars with no space or hyphen; without this the longest overflows a 320px screen by 382px.
		   The same rule and the same reason as the result card's excerpt, which this block replaced. */
		overflow-wrap: anywhere;
		margin: 0 0 var(--space-m);
	}
	.ask-answer__note {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		border-top: 1px solid var(--color-border);
		margin: var(--space-m) 0 0;
		padding-top: var(--space-s);
	}
	.ask-answer__src {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: 0 0 var(--space-s);
	}
	.ask-answer__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-m);
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
