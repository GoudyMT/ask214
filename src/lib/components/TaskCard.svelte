<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import { SNOOZE_PRESETS, snoozeUntilIso } from '$lib/timeline/snooze';
	import type { TimelineItem, TaskCategory, DisplayStatus, TaskStatus } from '$lib/timeline';

	let {
		item,
		onSetStatus,
		onSetSnooze
	}: {
		item: TimelineItem;
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze: (taskId: string, untilIso: string) => void;
	} = $props();

	// Inline snooze picker state (ephemeral; not persisted). Snooze toggles it open; a preset or a
	// picked date commits via onSetSnooze and closes it.
	let snoozeOpen = $state(false);
	let showDateInput = $state(false);
	let dateValue = $state('');

	function snooze(days: number): void {
		onSetSnooze(item.def.id, snoozeUntilIso(new Date(), days));
		closeSnooze();
	}

	function snoozeToDate(): void {
		if (!dateValue) return;
		onSetSnooze(item.def.id, dateValue);
		closeSnooze();
	}

	function closeSnooze(): void {
		snoozeOpen = false;
		showDateInput = false;
		dateValue = '';
	}

	const STATUS_LABEL: Record<DisplayStatus, string> = {
		upcoming: 'Upcoming',
		'start-now': 'Start now',
		overdue: 'Overdue',
		done: 'Done',
		skipped: 'Skipped',
		snoozed: 'Snoozed'
	};

	const CATEGORY_LABEL: Record<TaskCategory, string> = {
		medical: 'Medical',
		admin: 'Admin',
		benefits: 'Benefits',
		career: 'Career',
		finance: 'Finance'
	};

	// Status-specific date line (locked Session 19): upcoming -> when to start (target date);
	// start-now -> the closing deadline; overdue -> how long past it. Resolved states get the
	// collapsed treatment in C4; until then they fall back to the target date.
	const dateLine = $derived.by(() => {
		const end = formatTimelineDate(item.windowEndDate);
		switch (item.status) {
			case 'start-now':
				return `Window to ${end}`;
			case 'overdue':
				return `since ${end}`;
			default:
				return formatTimelineDate(item.targetDate);
		}
	});
</script>

<article class="task-card status-{item.status}">
	<div class="task-card__body">
		<h3 class="task-card__title">{item.def.title}</h3>
		<p class="task-card__why">
			<span class="task-card__chip category-{item.def.category}"
				>{CATEGORY_LABEL[item.def.category]}</span
			>{item.def.why}
		</p>
		<div class="task-card__actions">
			<button type="button" onclick={() => onSetStatus(item.def.id, 'done')}>Mark done</button>
			<button type="button" onclick={() => onSetStatus(item.def.id, 'skipped')}>Skip</button>
			<button type="button" onclick={() => (snoozeOpen = !snoozeOpen)}>Snooze</button>
		</div>
		{#if snoozeOpen}
			<div class="task-card__snooze">
				<span class="task-card__snooze-label">Snooze until</span>
				<div class="task-card__presets">
					{#each SNOOZE_PRESETS as preset (preset.days)}
						<button type="button" class="task-card__preset" onclick={() => snooze(preset.days)}>
							{preset.label}
						</button>
					{/each}
					<button type="button" class="task-card__preset" onclick={() => (showDateInput = true)}>
						Customize
					</button>
					<button type="button" class="task-card__snooze-cancel" onclick={closeSnooze}
						>Cancel</button
					>
				</div>
				{#if showDateInput}
					<div class="task-card__date-row">
						<input type="date" bind:value={dateValue} aria-label="Snooze until date" />
						<button
							type="button"
							class="task-card__snooze-go"
							onclick={snoozeToDate}
							disabled={!dateValue}>Snooze</button
						>
					</div>
				{/if}
			</div>
		{/if}
	</div>
	<div class="task-card__meta">
		<span class="task-card__status">{STATUS_LABEL[item.status]}</span>
		<span class="task-card__date">{dateLine}</span>
	</div>
</article>

<style>
	/* Open status card (spec section 7 + timeline-states.html mockup): a surface panel with a
	   status-colored 4px left edge; content-left (title / category chip + why), meta-right
	   (status label in the status color + date). Status is ALWAYS color + text label (WCAG, no
	   color-only). Reuses the locked state-color + size tokens (the mockup's sub-14px sizes are
	   not in the token registry; --font-size-s is the floor pending a token decision). */
	.task-card {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left-width: 4px;
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
		margin-bottom: var(--space-s);
	}

	.task-card__body {
		min-width: 0;
	}

	.task-card__title {
		margin: 0;
		font-size: var(--font-size-base);
		line-height: 1.3;
		font-weight: 600;
	}

	.task-card__why {
		margin: var(--space-xs) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.task-card__chip {
		display: inline-block;
		margin-right: var(--space-xs);
		padding: 1px 6px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* Action row (C4): quiet accent-link buttons (real <button>s for a11y, styled like the
	   mockup's action links). Add note joins here in a later C4 increment. */
	.task-card__actions {
		display: flex;
		gap: var(--space-m);
		margin-top: var(--space-s);
	}

	.task-card__actions button {
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}

	.task-card__actions button:hover {
		text-decoration: underline;
	}

	/* Inline snooze picker (C4 increment 2, Option B): preset pills + a "Customize" date input,
	   in an inset panel under the action row. */
	.task-card__snooze {
		margin-top: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
	}

	.task-card__snooze-label {
		display: block;
		margin-bottom: var(--space-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.task-card__presets {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		align-items: center;
	}

	.task-card__preset {
		padding: var(--space-xs) var(--space-m);
		background: none;
		color: var(--color-accent);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
	}

	.task-card__preset:hover {
		border-color: var(--color-accent);
	}

	.task-card__snooze-cancel {
		margin-left: auto;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		font-size: var(--font-size-s);
		text-decoration: underline;
		cursor: pointer;
	}

	.task-card__date-row {
		display: flex;
		gap: var(--space-s);
		align-items: center;
		margin-top: var(--space-s);
	}

	.task-card__date-row input {
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-s);
		padding: var(--space-xs) var(--space-s);
		font: inherit;
		font-size: var(--font-size-s);
	}

	/* The native calendar glyph renders dark + near-invisible on the dark input; invert it to
	   light (matches the EAOS date field). Webkit pseudo-element covers v1.0 (Chromium + Safari). */
	.task-card__date-row input::-webkit-calendar-picker-indicator {
		filter: invert(1);
		cursor: pointer;
	}

	.task-card__snooze-go {
		padding: var(--space-xs) var(--space-m);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-s);
		font: inherit;
		font-size: var(--font-size-s);
		font-weight: 600;
		cursor: pointer;
	}

	.task-card__snooze-go:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.task-card__meta {
		flex: none;
		text-align: right;
		white-space: nowrap;
	}

	.task-card__status {
		display: block;
		font-size: var(--font-size-s);
		font-weight: 600;
	}

	.task-card__date {
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* Category chip colors (Option C, Session 19): soft-filled tag - colored text + low-opacity
	   fill + tinted border, per category. Always paired with the category text label (not
	   color-only). Distinct from the status palette so a chip never reads as a status. */
	.category-medical {
		color: var(--color-category-medical);
		border-color: color-mix(in srgb, var(--color-category-medical) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-medical) 15%, transparent);
	}
	.category-admin {
		color: var(--color-category-admin);
		border-color: color-mix(in srgb, var(--color-category-admin) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-admin) 15%, transparent);
	}
	.category-benefits {
		color: var(--color-category-benefits);
		border-color: color-mix(in srgb, var(--color-category-benefits) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-benefits) 15%, transparent);
	}
	.category-career {
		color: var(--color-category-career);
		border-color: color-mix(in srgb, var(--color-category-career) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-career) 15%, transparent);
	}
	.category-finance {
		color: var(--color-category-finance);
		border-color: color-mix(in srgb, var(--color-category-finance) 45%, transparent);
		background: color-mix(in srgb, var(--color-category-finance) 15%, transparent);
	}

	/* Status edge + label colors (locked state-color tokens; open states for C3). */
	.status-upcoming {
		border-left-color: var(--color-border);
	}
	.status-upcoming .task-card__status {
		color: var(--color-fg-muted);
	}

	.status-start-now {
		border-left-color: var(--color-accent);
	}
	.status-start-now .task-card__status {
		color: var(--color-accent);
	}

	.status-overdue {
		border-left-color: var(--color-danger);
	}
	.status-overdue .task-card__status {
		color: var(--color-danger);
	}
</style>
