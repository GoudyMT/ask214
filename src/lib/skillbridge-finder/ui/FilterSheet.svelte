<script lang="ts">
	import { tick } from 'svelte';
	import { INDUSTRIES } from '../contract/listing';
	import type { FinderFilters } from '../state/types';
	import type { FinderStore } from '../state/store.svelte';
	import type { FinderSession } from './session.svelte';
	import {
		BRANCH_ORDER,
		FORMAT_LABELS,
		FORMAT_ORDER,
		LENGTH_BUCKETS,
		bucketOn,
		countBy,
		toggled,
		toggledBucket,
		withFilter
	} from './list-model';

	type Props = { session: FinderSession; finder: FinderStore; onclose?: () => void };
	let { session, finder, onclose }: Props = $props();

	// The sheet lists this many fields until the person asks for all of them.
	const FIELDS_SHOWN = 8;
	const SAVE_FAILED = 'Could not save that change. Try again.';

	let dialogEl: HTMLDialogElement | undefined;
	let titleEl: HTMLElement | undefined;
	let fieldsetEl: HTMLFieldSetElement | undefined;
	let showAll = $state(false);
	let problem = $state<string | null>(null);

	const filters = $derived(finder.filters);
	/** The list under every filter but one, so a value's count is what ticking it would leave. */
	const rowsWithout = (key: keyof FinderFilters) =>
		session.matchesWith(withFilter(filters, key, undefined));
	const formatCounts = $derived(
		countBy(rowsWithout('delivery'), FORMAT_ORDER, (l, v) => l.m === v)
	);
	const fieldCounts = $derived(
		countBy(rowsWithout('industries'), INDUSTRIES, (l, v) => l.ind.includes(v))
	);
	const branchCounts = $derived(
		countBy(rowsWithout('branches'), BRANCH_ORDER, (l, v) => l.b.includes(v))
	);
	const lengthCounts = $derived(
		countBy(
			rowsWithout('durations'),
			LENGTH_BUCKETS,
			(l, bucket) => l.d !== undefined && bucket.durations.includes(l.d)
		)
	);
	const fields = $derived(
		showAll
			? INDUSTRIES
			: INDUSTRIES.filter(
					(industry, n) => n < FIELDS_SHOWN || filters.industries?.includes(industry)
				)
	);
	const total = $derived(session.results.length);

	export function show(): void {
		dialogEl?.showModal();
		// The browser would pick the scrolling box, which has no name.
		titleEl?.focus();
	}

	/** The button asking for them goes with the click, so focus moves to the first new field that can be ticked. */
	async function showAllFields(): Promise<void> {
		const had = new Set(fields);
		showAll = true;
		await tick();
		const added = [...(fieldsetEl?.querySelectorAll('input') ?? [])].filter(
			(_, n) => !had.has(INDUSTRIES[n]!)
		);
		(added.find((box) => !box.disabled) ?? fieldsetEl)?.focus();
	}

	/** A change is written to the record as it is made; one that fails reads the record again and says so. */
	async function change(update: (current: FinderFilters) => FinderFilters): Promise<void> {
		problem = null;
		try {
			await finder.setFilters(update);
		} catch {
			await finder.refresh().catch(() => undefined);
			problem = SAVE_FAILED;
		}
	}
</script>

<dialog
	bind:this={dialogEl}
	class="sheet"
	aria-labelledby="finder-sheet-title"
	onclose={() => onclose?.()}
>
	<div class="sheet__body">
		<h2 id="finder-sheet-title" tabindex="-1" bind:this={titleEl}>Filters</h2>

		<fieldset>
			<legend>Format</legend>
			{#each FORMAT_ORDER as format (format)}
				{@const on = filters.delivery?.includes(format) ?? false}
				<label class="sheet__row">
					<input
						type="checkbox"
						checked={on}
						disabled={!on && formatCounts.get(format) === 0}
						onchange={() =>
							void change((f) => withFilter(f, 'delivery', toggled(f.delivery, format)))}
					/>
					<span>{FORMAT_LABELS[format]}</span>
				</label>
			{/each}
		</fieldset>

		<fieldset tabindex="-1" bind:this={fieldsetEl}>
			<legend>Field</legend>
			{#each fields as industry (industry)}
				{@const on = filters.industries?.includes(industry) ?? false}
				{@const count = fieldCounts.get(industry) ?? 0}
				<label class="sheet__row">
					<input
						type="checkbox"
						checked={on}
						disabled={!on && count === 0}
						onchange={() =>
							void change((f) => withFilter(f, 'industries', toggled(f.industries, industry)))}
					/>
					<span class="sheet__name">{industry}</span>
					<span class="sheet__count">{count}</span>
				</label>
			{/each}
			{#if !showAll}
				<button type="button" class="sheet__link" onclick={() => void showAllFields()}
					>Show all {INDUSTRIES.length}</button
				>
			{/if}
		</fieldset>

		<fieldset>
			<legend>Branch listed</legend>
			{#each BRANCH_ORDER as branch (branch)}
				{@const on = filters.branches?.includes(branch) ?? false}
				<label class="sheet__row">
					<input
						type="checkbox"
						checked={on}
						disabled={!on && branchCounts.get(branch) === 0}
						onchange={() =>
							void change((f) => withFilter(f, 'branches', toggled(f.branches, branch)))}
					/>
					<span>{branch}</span>
				</label>
			{/each}
		</fieldset>

		<fieldset>
			<legend>Length</legend>
			<div class="sheet__pills">
				{#each LENGTH_BUCKETS as bucket (bucket.label)}
					{@const on = bucketOn(filters.durations, bucket.durations)}
					<button
						type="button"
						class="sheet__pill"
						aria-pressed={on}
						disabled={!on && lengthCounts.get(bucket) === 0}
						onclick={() =>
							void change((f) =>
								withFilter(f, 'durations', toggledBucket(f.durations, bucket.durations))
							)}>{bucket.label}</button
					>
				{/each}
			</div>
		</fieldset>

		{#if problem}<p class="sheet__problem" role="alert">{problem}</p>{/if}
	</div>

	<div class="sheet__footer">
		<button type="button" class="sheet__primary" onclick={() => dialogEl?.close()}
			>Show {total} {total === 1 ? 'program' : 'programs'}</button
		>
		<button type="button" class="sheet__link" onclick={() => void change(() => ({}))}
			>Clear all</button
		>
	</div>
</dialog>

<style>
	/* A sheet rising from the bottom edge on a phone; from 600 px a dialog in the middle. */
	.sheet {
		width: 100%;
		max-width: none;
		max-height: 85dvh;
		margin: auto 0 0;
		padding: 0;
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l) var(--radius-l) 0 0;
	}

	/* Only an open dialog lays out; a closed one keeps its hidden display. */
	.sheet[open] {
		display: flex;
		flex-direction: column;
	}

	.sheet::backdrop {
		background: rgb(0 0 0 / 55%);
	}

	@media (min-width: 600px) {
		.sheet {
			width: min(520px, calc(100% - 2 * var(--space-l)));
			max-height: 80dvh;
			margin: auto;
			border-radius: var(--radius-l);
		}
	}

	.sheet__body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-m);
	}

	.sheet h2 {
		margin: 0 0 var(--space-s);
		font-size: var(--font-size-xl);
	}

	fieldset {
		margin: 0 0 var(--space-m);
		padding: 0;
		border: none;
	}

	legend {
		padding: 0;
		margin-bottom: var(--space-xs);
		font-weight: 600;
	}

	.sheet__row {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		min-height: 44px;
	}

	.sheet__row input {
		flex: none;
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--color-accent);
	}

	.sheet__row input:disabled + span {
		color: var(--color-fg-muted);
	}

	.sheet__name {
		flex: 1;
	}

	.sheet__count {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.sheet__pills {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
	}

	.sheet__pill {
		min-height: 44px;
		padding: 0 var(--space-m);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}

	.sheet__pill[aria-pressed='true'] {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		color: var(--color-fg);
	}

	.sheet__pill:disabled {
		color: var(--color-fg-muted);
		cursor: default;
	}

	.sheet__link {
		min-height: 44px;
		padding: 0 var(--space-xs);
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.sheet__problem {
		margin: 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	/* Outside the scrolling body, so it stays in view however long the choices run. */
	.sheet__footer {
		flex: none;
		display: flex;
		align-items: center;
		gap: var(--space-m);
		padding: var(--space-s) var(--space-m);
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
	}

	.sheet__primary {
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

	@media (forced-colors: active) {
		.sheet__pill[aria-pressed='true'] {
			outline: 2px solid Highlight;
		}
	}
</style>
