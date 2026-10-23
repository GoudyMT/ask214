<script lang="ts">
	import { tick } from 'svelte';
	import { INDUSTRIES, type Delivery, type Industry } from '../contract/listing';
	import type { ZipsTable } from '../contract/tables';
	import type { FinderFilters, FinderPlace, FinderRadius, FinderSetup } from '../state/types';
	import { NOT_AFFILIATED, PLACE_PROBLEM } from './copy';
	import { FORMAT_LABELS, FORMAT_ORDER, toggled } from './list-model';
	import { parsePlaceText, placeText, suggestPlaces, type PlaceSuggestion } from './place-text';

	type Props = {
		/** What is saved already, when the person is changing it. */
		initial?: { setup: FinderSetup; filters: FinderFilters };
		/** A place the person's own profile names, offered by name and used only when they tap it. */
		destination?: FinderPlace | null;
		/** The ZIP table, asked for when the first digit is typed; undefined when it could not be fetched. */
		loadZips: () => Promise<ZipsTable | undefined>;
		onsave: (setup: FinderSetup, filters: FinderFilters) => Promise<void>;
		/** A failed save, said beside the buttons. */
		error?: string | null;
	};
	let { initial, destination = null, loadZips, onsave, error = null }: Props = $props();

	const RADII: { value: FinderRadius; label: string }[] = [
		{ value: 25, label: '25 mi' },
		{ value: 50, label: '50 mi' },
		{ value: 100, label: '100 mi' },
		{ value: 'any', label: 'Any distance' }
	];
	const DEFAULT_RADIUS: FinderRadius = 50;
	// The fields most listings fall under; the rest are one tap away.
	const COMMON_FIELDS: readonly Industry[] = [
		'Installation, Maintenance, and Repair',
		'Computer and Mathematical',
		'Construction and Extraction',
		'Healthcare Support',
		'Transportation and Material Moving',
		'Management'
	];

	// The saved values only seed the form; the form then owns them.
	// svelte-ignore state_referenced_locally
	const seed = initial;
	let text = $state(seed?.setup.place ? placeText(seed.setup.place) : '');
	let radius = $state<FinderRadius>(seed?.setup.radius ?? DEFAULT_RADIUS);
	let territories = $state(seed?.setup.territories ?? false);
	let overseas = $state(seed?.setup.overseas ?? false);
	let delivery = $state<Delivery[]>(seed?.filters.delivery ?? []);
	let industries = $state<Industry[]>(seed?.filters.industries ?? []);
	let showAllFields = $state(false);
	let zips = $state.raw<ZipsTable | undefined>(undefined);
	let zipsAsked = false;
	let open = $state(false);
	let active = $state(-1);
	let busy = $state(false);
	let problem = $state<string | null>(null);
	let fieldEl = $state<HTMLInputElement>();
	// One question a screen: where, how, what field. The answers live in this form across the steps and are written
	// only by Show programs (or Skip all).
	const STEPS = 3;
	let step = $state(1);
	let headingEl = $state<HTMLElement>();

	async function goTo(next: number): Promise<void> {
		step = next;
		await tick();
		headingEl?.focus();
	}

	/** Step 1 moves on only with a place it can use, or none; a place it cannot read is said on that step. */
	async function next(): Promise<void> {
		if (busy) return;
		if (step === 1) {
			busy = true;
			try {
				const where = await resolvePlace();
				if ('problem' in where) {
					problem = where.problem;
					fieldEl?.focus();
					return;
				}
			} finally {
				busy = false;
			}
		}
		await goTo(step + 1);
	}

	const typed = $derived(parsePlaceText(text));
	// A whole ZIP needs no list; left open, it would also sit over the reach pills that appear under the field.
	const suggestions = $derived<PlaceSuggestion[]>(
		open && typed?.kind !== 'zip' ? suggestPlaces(text, zips) : []
	);
	const fieldsShown = $derived(
		showAllFields
			? INDUSTRIES
			: [...COMMON_FIELDS, ...industries.filter((i) => !COMMON_FIELDS.includes(i))]
	);

	function ask(): void {
		if (zipsAsked) return;
		zipsAsked = true;
		loadZips().then(
			(table) => (zips = table),
			() => (zips = undefined)
		);
	}

	function onInput(): void {
		problem = null;
		open = true;
		active = -1;
		if (/^\d/.test(text.trim())) ask();
	}

	function choose(suggestion: PlaceSuggestion): void {
		text = suggestion.label;
		open = false;
		active = -1;
		problem = null;
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (suggestions.length === 0) return;
			e.preventDefault();
			const move = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + move + suggestions.length) % suggestions.length;
		} else if (e.key === 'Enter' && active >= 0) {
			// The pick is the answer to Enter; the form is not submitted by it.
			e.preventDefault();
			const pick = suggestions[active];
			if (pick) choose(pick);
		} else if (e.key === 'Escape' && open) {
			e.preventDefault();
			open = false;
			active = -1;
		}
	}

	/** The place the field names, or why it names none; an empty field is no place, which is allowed. */
	async function resolvePlace(): Promise<{ place?: FinderPlace } | { problem: string }> {
		if (text.trim() === '') return {};
		const place = parsePlaceText(text);
		if (place === null) return { problem: PLACE_PROBLEM };
		if (place.kind === 'zip') {
			zipsAsked = true;
			zips ??= await loadZips().catch(() => undefined);
			if (zips === undefined) {
				return {
					problem:
						'A ZIP code needs a one-time download of the ZIP list. Check your connection, or pick a state.'
				};
			}
			if (!zips.rows.some((row) => row[0] === place.zip)) {
				return { problem: "We couldn't find that ZIP code. Check it, or pick a state." };
			}
		}
		return { place };
	}

	async function save(skip: boolean): Promise<void> {
		if (busy) return;
		busy = true;
		problem = null;
		try {
			if (skip) {
				await onsave({ territories: false, overseas: false }, {});
				return;
			}
			const where = await resolvePlace();
			if ('problem' in where) {
				problem = where.problem;
				fieldEl?.focus();
				return;
			}
			const place = where.place;
			const filters: FinderFilters = {
				...(delivery.length > 0 ? { delivery: [...delivery].sort((a, b) => a - b) } : {}),
				...(industries.length > 0
					? { industries: INDUSTRIES.filter((i) => industries.includes(i)) }
					: {})
			};
			await onsave(
				{
					...(place ? { place } : {}),
					...(place?.kind === 'zip' ? { radius } : {}),
					territories,
					overseas
				},
				filters
			);
		} finally {
			busy = false;
		}
	}
</script>

<!-- The form never submits by itself: a submit would put what was typed into the address. -->
<form
	class="setup"
	novalidate
	onsubmit={(e) => {
		e.preventDefault();
		void (step < STEPS ? next() : save(false));
	}}
>
	<p class="setup__intro">
		Find DoD SkillBridge programs near you or online. What you enter stays on this device.
	</p>

	<p class="setup__step">Step {step} of {STEPS}</p>
	{#if step === 1}
		<h2 bind:this={headingEl} tabindex="-1">Where?</h2>
		<div class="setup__field">
			<label for="finder-place">ZIP code or state</label>
			<input
				id="finder-place"
				bind:this={fieldEl}
				bind:value={text}
				type="text"
				role="combobox"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				aria-expanded={suggestions.length > 0}
				aria-controls="finder-place-list"
				aria-autocomplete="list"
				aria-activedescendant={active >= 0 ? `finder-place-${active}` : undefined}
				aria-describedby={problem ? 'finder-setup-problem' : undefined}
				aria-invalid={problem ? true : undefined}
				oninput={onInput}
				onkeydown={onKey}
				onblur={() => {
					open = false;
					active = -1;
				}}
			/>
			<ul
				id="finder-place-list"
				class="setup__list"
				role="listbox"
				hidden={suggestions.length === 0}
			>
				{#each suggestions as suggestion, n (suggestion.label)}
					<!-- A press must not move focus off the field, or the list closes before the press lands. The keys are
				     the field's (combobox pattern: focus stays on the input), so the options take only the pointer. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={`finder-place-${n}`}
						role="option"
						aria-selected={n === active}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => choose(suggestion)}
					>
						{suggestion.label}
					</li>
				{/each}
			</ul>
			{#if problem}<p id="finder-setup-problem" class="setup__problem" role="alert">
					{problem}
				</p>{/if}
		</div>

		{#if destination}
			<p class="setup__profile">
				From your profile:
				<button
					type="button"
					class="setup__pill"
					onclick={() => choose({ label: placeText(destination), place: destination })}
					>Use {placeText(destination)}</button
				>
			</p>
		{/if}

		{#if typed?.kind === 'zip'}
			<div class="setup__pills">
				{#each RADII as r (r.label)}
					<button
						type="button"
						class="setup__pill"
						aria-pressed={radius === r.value}
						onclick={() => (radius = r.value)}>{r.label}</button
					>
				{/each}
			</div>
		{/if}

		<label class="setup__check"
			><input type="checkbox" bind:checked={territories} /> Include US territories</label
		>
		<label class="setup__check"
			><input type="checkbox" bind:checked={overseas} /> Include programs overseas</label
		>
	{:else if step === 2}
		<h2 bind:this={headingEl} tabindex="-1">How?</h2>
		<div class="setup__pills">
			{#each FORMAT_ORDER as format (format)}
				<button
					type="button"
					class="setup__pill"
					aria-pressed={delivery.includes(format)}
					onclick={() => (delivery = toggled(delivery, format) ?? [])}
					>{FORMAT_LABELS[format]}</button
				>
			{/each}
		</div>
	{:else}
		<h2 bind:this={headingEl} tabindex="-1">
			What field? <span class="setup__optional">optional</span>
		</h2>
		<div class="setup__pills">
			{#each fieldsShown as industry (industry)}
				<button
					type="button"
					class="setup__pill"
					aria-pressed={industries.includes(industry)}
					onclick={() => (industries = toggled(industries, industry) ?? [])}>{industry}</button
				>
			{/each}
		</div>
		<button
			type="button"
			class="setup__link"
			aria-expanded={showAllFields}
			onclick={() => (showAllFields = !showAllFields)}
			>{showAllFields ? 'Show fewer fields' : `Show all ${INDUSTRIES.length} fields`}</button
		>
	{/if}

	{#if error}<p class="setup__problem" role="alert">{error}</p>{/if}
	<div class="setup__actions">
		{#if step > 1}
			<button type="button" class="setup__secondary" onclick={() => void goTo(step - 1)}
				>Back</button
			>
		{/if}
		<button type="submit" class="setup__primary" aria-busy={busy}
			>{step < STEPS ? 'Next' : 'Show programs'}</button
		>
		<button type="button" class="setup__link" onclick={() => void save(true)}>Skip all</button>
	</div>

	<p class="setup__note">{NOT_AFFILIATED}</p>
</form>

<style>
	.setup__intro {
		margin: 0 0 var(--space-s);
	}

	.setup__step {
		margin: var(--space-m) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.setup h2 {
		font-size: var(--font-size-l);
		margin: var(--space-xs) 0 var(--space-s);
	}

	.setup h2:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.setup__secondary {
		min-height: 44px;
		padding: 0 var(--space-l);
		background: none;
		color: var(--color-accent);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
		cursor: pointer;
	}

	.setup__optional {
		font-size: var(--font-size-s);
		font-weight: 400;
		color: var(--color-fg-muted);
	}

	.setup__field {
		position: relative;
	}

	.setup__field label {
		display: block;
		margin-bottom: var(--space-xs);
		font-weight: 600;
		font-size: var(--font-size-s);
	}

	.setup__field input {
		width: 100%;
		min-height: 44px;
		padding: 0 var(--space-m);
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
	}

	.setup__list {
		position: absolute;
		z-index: 5;
		left: 0;
		right: 0;
		margin: var(--space-xs) 0 0;
		padding: 0;
		list-style: none;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		overflow: hidden;
	}

	.setup__list[hidden] {
		display: none;
	}

	.setup__list li {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-m);
		cursor: pointer;
	}

	.setup__list li[aria-selected='true'],
	.setup__list li:hover {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
	}

	.setup__profile {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-s);
		margin: var(--space-m) 0 0;
	}

	.setup__pills {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		margin-top: var(--space-m);
	}

	.setup h2 + .setup__pills {
		margin-top: 0;
	}

	/* The look of the timeline card's action pills; selected adds the accent edge and a soft fill. */
	.setup__pill {
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
		text-align: left;
		cursor: pointer;
	}

	.setup__pill:hover {
		border-color: var(--color-accent);
	}

	.setup__pill[aria-pressed='true'] {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 18%, transparent);
		color: var(--color-fg);
	}

	.setup__check {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		min-height: 44px;
	}

	.setup__check input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--color-accent);
	}

	.setup__link {
		display: inline-flex;
		align-items: center;
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

	.setup__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-m);
	}

	.setup__primary {
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

	.setup__primary:hover {
		background: var(--color-accent-muted);
	}

	.setup__problem {
		margin: var(--space-s) 0 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}

	.setup__note {
		margin: var(--space-m) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	@media (forced-colors: active) {
		.setup__pill[aria-pressed='true'],
		.setup__list li[aria-selected='true'] {
			outline: 2px solid Highlight;
		}
	}
</style>
