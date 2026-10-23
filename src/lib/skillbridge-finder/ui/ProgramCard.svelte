<script lang="ts">
	import { DELIVERY, type Listing } from '../contract/listing';
	import type { SavedStatus } from '../state/saved-status';
	import type { FinderStore } from '../state/store.svelte';
	import { MAX_COMPARE } from '../state/types';
	import { formatTimelineDate } from '../../timeline/format-date';
	import { localTodayIso } from '../../timeline/day-math';
	import { DIB_LINE, NOT_AFFILIATED } from './copy';
	import {
		branchesLine,
		jobCodesLine,
		lengthLine,
		mailtoHref,
		placeLine,
		safeHttps
	} from './format';
	import { FORMAT_LABELS, KIND_LABELS } from './list-model';
	import type { FinderSession } from './session.svelte';

	type Props = {
		listing: Listing;
		/** Miles from the person's place, when the list could measure one. */
		miles?: number | undefined;
		isNew: boolean;
		/** Set for a saved program: whether the weekly files still list it. */
		status?: SavedStatus | undefined;
		session: FinderSession;
		finder: FinderStore;
	};
	let { listing, miles, isNew, status, session, finder }: Props = $props();

	const uid = $props.id();
	const SKILLBRIDGE = 'https://www.skillbridge.mil/';
	const COMPARE_FULL = `You can compare up to ${MAX_COMPARE}. Remove one first.`;
	const SAVED_FULL = 'You can keep up to 200 programs. Remove one first.';
	const NOT_SAVED = 'Could not save that change. Try again.';

	// Each format is a picture, a word and a colour; the word carries the meaning.
	const FORMAT_TAGS = {
		[DELIVERY.inPerson]: {
			color: 'var(--color-category-medical)',
			path: 'M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5z'
		},
		[DELIVERY.remote]: { color: 'var(--color-category-benefits)', path: 'M5 6h14v9H5zM3 18h18' },
		[DELIVERY.hybrid]: {
			color: 'var(--color-category-finance)',
			path: 'M8 19s-4-3.6-4-7.2a4 4 0 0 1 8 0C12 15.4 8 19 8 19zM14 9h7v6h-7zM13 18h9'
		}
	} as const;

	let open = $state(false);
	let note = $state<string | null>(null);

	const format = $derived(FORMAT_TAGS[listing.m]);
	const gone = $derived(status?.kind === 'missing');
	const saved = $derived(finder.saved.some((item) => item.id === listing.i));
	const comparing = $derived(finder.compare.includes(listing.i));
	const website = $derived(safeHttps(listing.w));
	const linkedin = $derived(safeHttps(listing.li));
	const form = $derived(safeHttps(listing.u));

	function toggle(): void {
		open = !open;
		if (open) void session.markOpened(listing.i);
	}

	// A tap on the card itself opens it, as a tap on its summary does; a tap on any control inside, or the end of a
	// text selection, is not that.
	function onCardClick(e: MouseEvent): void {
		const target = e.target;
		if (target instanceof Element && target.closest('a, button, input, label, select, textarea'))
			return;
		if (window.getSelection()?.isCollapsed === false) return;
		toggle();
	}

	async function onSave(): Promise<void> {
		note = null;
		try {
			if (saved) await finder.unsave(listing.i);
			else await finder.save(listing, localTodayIso(new Date()));
		} catch (e) {
			note = e instanceof Error && e.message === 'E_FINDER_SAVED_FULL' ? SAVED_FULL : NOT_SAVED;
			await finder.refresh().catch(() => undefined);
		}
	}

	async function onCompare(): Promise<void> {
		note = null;
		if (!comparing && finder.compare.length >= MAX_COMPARE) {
			note = COMPARE_FULL;
			return;
		}
		try {
			if (comparing) await finder.removeCompare(listing.i);
			else await finder.addCompare(listing.i);
		} catch (e) {
			note = e instanceof Error && e.message === 'E_FINDER_COMPARE_FULL' ? COMPARE_FULL : NOT_SAVED;
			await finder.refresh().catch(() => undefined);
		}
	}

	// The click goes on to open the site in a new tab; this only puts the name on the clipboard first.
	function copyName(): void {
		try {
			void navigator.clipboard.writeText(listing.n).catch(() => undefined);
		} catch {
			// No clipboard here: the site still opens, and the name is on the card to type.
		}
	}
</script>

<!-- A tap anywhere on the card opens it; the keyboard has the summary button, so the card takes only the pointer. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article class="card" onclick={onCardClick}>
	<h3 class="card__heading">
		<button
			type="button"
			class="card__summary"
			aria-expanded={open}
			aria-controls="{uid}-details"
			onclick={toggle}
		>
			<span class="card__tags">
				{#if gone}<span class="card__tag card__tag--gone">No longer listed</span>{/if}
				{#if isNew}<span class="card__tag card__tag--new">New</span>{/if}
				<span class="card__tag card__tag--format" style:--tag={format.color}>
					<svg
						viewBox="0 0 24 24"
						width="16"
						height="16"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"><path d={format.path} /></svg
					>{FORMAT_LABELS[listing.m]}
				</span>
				{#if listing.dib}<span class="card__tag card__tag--dib">DIB</span>{/if}
			</span>
			<span class="card__org">{listing.n}</span>
			<span class="card__program">{listing.p}</span>
			<span class="card__facts">
				<span>{placeLine(listing, miles)}</span>
				<span>{lengthLine(listing)}</span>
				<span>{branchesLine(listing)}</span>
			</span>
		</button>
	</h3>

	<div class="card__details" class:card__details--open={open} id="{uid}-details" inert={!open}>
		<div class="card__inner">
			<dl class="card__dl">
				{#if listing.r && listing.r.length > 0}
					<dt>Roles</dt>
					<dd>{listing.r.join(', ')}</dd>
				{/if}
				{#if listing.ind.length > 0}
					<dt>Field</dt>
					<dd>{listing.ind.join('; ')}</dd>
				{/if}
				<dt>Job codes</dt>
				<dd>{jobCodesLine(listing)}</dd>
				{#if listing.k}
					<dt>Type</dt>
					<dd>{KIND_LABELS[listing.k]}</dd>
				{/if}
				<dt>Posted</dt>
				<dd>{formatTimelineDate(listing.dc)} on skillbridge.mil</dd>
				{#if listing.e}
					<dt>Contact</dt>
					<dd>
						<a href={mailtoHref(listing.e)} rel="external">{listing.e}</a>
						<span class="card__muted">Shown as DoD lists it publicly on skillbridge.mil.</span>
					</dd>
				{:else if form}
					<dt>Contact</dt>
					<dd>
						<a href={form.href} target="_blank" rel="noopener noreferrer external"
							>Online form at {form.hostname}<span aria-hidden="true"> &#8599;</span><span
								class="visually-hidden"
							>
								(opens in a new tab)</span
							></a
						>
					</dd>
				{/if}
			</dl>

			{#if listing.dib}
				<p class="card__dib"><span class="card__tag card__tag--dib">DIB</span> {DIB_LINE}</p>
			{/if}

			{#if website || linkedin}
				<p class="card__links">
					{#if website}
						<a href={website.href} target="_blank" rel="noopener noreferrer external"
							>Company website<span aria-hidden="true"> &#8599;</span><span class="visually-hidden">
								(opens in a new tab)</span
							></a
						>
					{/if}
					{#if linkedin}
						<a href={linkedin.href} target="_blank" rel="noopener noreferrer external"
							>LinkedIn<span aria-hidden="true"> &#8599;</span><span class="visually-hidden">
								(opens in a new tab)</span
							></a
						>
					{/if}
				</p>
			{/if}

			<a
				class="card__copy"
				href={SKILLBRIDGE}
				target="_blank"
				rel="noopener noreferrer external"
				onclick={copyName}
				>Copy the name, then open skillbridge.mil<span class="visually-hidden">
					(opens in a new tab)</span
				></a
			>
			<p class="card__muted">
				skillbridge.mil has no link to a single program. Paste the name into its search.
			</p>
			<p class="card__muted">{NOT_AFFILIATED}</p>
		</div>
	</div>

	<div class="card__actions">
		<button type="button" class="card__pill" aria-pressed={saved} onclick={() => void onSave()}
			>{saved ? 'Saved' : 'Save'}</button
		>
		{#if !gone}
			<button
				type="button"
				class="card__pill"
				aria-pressed={comparing}
				onclick={() => void onCompare()}>{comparing ? 'Comparing' : 'Compare'}</button
			>
		{/if}
		<!-- Not a control: a picture of the summary's action, so a tap on it lands on the card. -->
		<span class="card__cue" aria-hidden="true"
			>{open ? 'Less' : 'Details'}<span class="card__chevron" class:card__chevron--up={open}
			></span></span
		>
	</div>
	{#if note}<p class="card__note" role="status">{note}</p>{/if}
</article>

<style>
	.card {
		margin-bottom: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
	}

	.card__heading {
		margin: 0;
		font-size: var(--font-size-base);
		font-weight: 400;
		line-height: 1.3;
	}

	.card__summary {
		display: block;
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	/* One line of tags: they wrap only when a very large text size leaves no other way to show them. */
	.card__tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin-bottom: var(--space-xs);
	}

	.card__tag {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 1px 6px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		line-height: 1.4;
		white-space: nowrap;
	}

	.card__tag--new {
		border-color: var(--color-accent);
		color: var(--color-accent);
		font-weight: 600;
	}

	.card__tag--gone {
		border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.card__tag--format {
		border-color: color-mix(in srgb, var(--tag) 45%, transparent);
		background: color-mix(in srgb, var(--tag) 12%, transparent);
		color: var(--tag);
		font-weight: 600;
	}

	.card__tag--dib {
		border-color: color-mix(in srgb, var(--color-category-career) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-career) 12%, transparent);
		color: var(--color-category-career);
	}

	.card__org {
		display: block;
		font-weight: 600;
	}

	.card__program {
		display: block;
		font-size: var(--font-size-s);
	}

	.card__facts {
		display: block;
		margin-top: var(--space-xs);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.card__facts > span {
		display: inline-block;
		margin-right: var(--space-m);
	}

	/* The details open by growing from nothing: a grid row from 0fr to 1fr, which a plain height cannot animate. */
	.card__details {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows 220ms ease;
	}

	.card__details--open {
		grid-template-rows: 1fr;
	}

	@media (prefers-reduced-motion: reduce) {
		.card__details {
			transition: none;
		}
	}

	.card__inner {
		min-height: 0;
		overflow: hidden;
	}

	.card__dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-xs) var(--space-m);
		margin: var(--space-s) 0 0;
		font-size: var(--font-size-s);
	}

	.card__dl dt {
		color: var(--color-fg-muted);
	}

	.card__dl dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.card__muted {
		display: block;
		margin: var(--space-xs) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.card__dib {
		margin: var(--space-s) 0 0;
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		font-size: var(--font-size-s);
	}

	.card__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-m);
		margin: var(--space-s) 0 0;
		font-size: var(--font-size-s);
	}

	.card__copy {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		margin-top: var(--space-s);
		padding: var(--space-xs) var(--space-m);
		background: var(--color-accent);
		color: var(--color-bg);
		border-radius: var(--radius-m);
		font-weight: 600;
		text-align: center;
		text-decoration: none;
	}

	.card__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin-top: var(--space-s);
	}

	.card__pill {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		white-space: nowrap;
		cursor: pointer;
	}

	.card__pill:hover {
		border-color: var(--color-accent);
	}

	.card__pill[aria-pressed='true'] {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		color: var(--color-fg);
	}

	/* The end of the action row. Taking the rest of the width makes it the card's own space to tap. */
	.card__cue {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		margin-left: auto;
		padding: 0 var(--space-xs);
		color: var(--color-accent);
		font-size: var(--font-size-s);
		font-weight: 600;
	}

	.card__chevron {
		width: 8px;
		height: 8px;
		border-right: 2px solid currentColor;
		border-bottom: 2px solid currentColor;
		transform: rotate(45deg);
		margin-bottom: 3px;
	}

	.card__chevron--up {
		transform: rotate(-135deg);
		margin-bottom: -3px;
	}

	.card__note {
		margin: var(--space-xs) 0 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (forced-colors: active) {
		.card__pill[aria-pressed='true'] {
			outline: 2px solid Highlight;
		}
	}
</style>
