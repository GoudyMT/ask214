<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import { SNOOZE_PRESETS, snoozeUntilIso } from '$lib/timeline/snooze';
	import type { TimelineItem, TaskCategory, DisplayStatus, TaskStatus } from '$lib/timeline';

	let {
		item,
		onSetStatus,
		onSetSnooze,
		onSetNote
	}: {
		item: TimelineItem;
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze: (taskId: string, untilIso: string) => void;
		onSetNote?: (taskId: string, note: string | undefined) => void;
	} = $props();

	// Inline snooze picker state (ephemeral; not persisted). Snooze toggles it open; a preset or a
	// picked date commits via onSetSnooze and closes it.
	let snoozeOpen = $state(false);
	let showDateInput = $state(false);
	let dateValue = $state('');

	// C4 increment 3: resolved tasks (done/skipped/snoozed) collapse to a one-line disclosure.
	// Expansion is ephemeral local state (spec section 7 - collapse state is never stored).
	let expanded = $state(false);
	const isResolved = $derived(
		item.status === 'done' || item.status === 'skipped' || item.status === 'snoozed'
	);

	// Auto-collapse on any status transition (mark done/skip/snooze, or restore -> re-resolve): a
	// resolved card lands collapsed by default; expanding is the deliberate action. A plain toggle
	// does not change item.status, so manual expand/collapse is preserved. prevStatus starts
	// undefined (NOT snapshotting the prop) so there is no spurious reset on mount.
	let prevStatus = $state<DisplayStatus | undefined>(undefined);
	$effect(() => {
		if (prevStatus !== undefined && item.status !== prevStatus) {
			expanded = false;
		}
		prevStatus = item.status;
	});

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

	// Inline note editor (C4 increment 4): Add/Edit note -> textarea (prefilled with any existing
	// note); Save commits via onSetNote (empty string clears it); Cancel discards.
	let noteOpen = $state(false);
	let noteValue = $state('');

	function openNote(): void {
		noteValue = item.note ?? '';
		noteOpen = true;
	}

	function saveNote(): void {
		onSetNote?.(item.def.id, noteValue);
		closeNote();
	}

	function closeNote(): void {
		noteOpen = false;
		noteValue = '';
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
	// start-now -> the closing deadline; overdue -> how long past it. Resolved states use the
	// collapsed treatment instead (this line is only read on open cards).
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

{#snippet noteSection()}
	{#if noteOpen}
		<div class="task-card__note">
			<textarea
				class="task-card__note-input"
				bind:value={noteValue}
				aria-label="Note"
				placeholder="Add a note..."
			></textarea>
			<div class="task-card__note-actions">
				<button type="button" class="task-card__note-save" onclick={saveNote}>Save</button>
				<button type="button" class="task-card__note-cancel" onclick={closeNote}>Cancel</button>
			</div>
		</div>
	{:else if item.note}
		<div class="task-card__note-shown">
			<span class="task-card__note-label">Your note</span>
			<span class="task-card__note-text">{item.note}</span>
		</div>
	{/if}
{/snippet}

{#if isResolved && !expanded}
	<!-- Collapsed resolved line: the whole row is the disclosure control (button + aria-expanded).
	     Decision A: snoozed shows its date; done/skipped show none. -->
	<button
		type="button"
		class="task-line line-{item.status}"
		aria-expanded="false"
		onclick={() => (expanded = true)}
	>
		<span class="task-line__title">{item.def.title}</span>
		{#if item.note}
			<span class="task-line__note-dot" title="Has a note" aria-label="Has a note"></span>
		{/if}
		<span class="task-line__status">{STATUS_LABEL[item.status]}</span>
		{#if item.status === 'snoozed' && item.snoozeUntil}
			<span class="task-line__date">to {formatTimelineDate(item.snoozeUntil)}</span>
		{/if}
		<span class="caret caret--right" aria-hidden="true"></span>
	</button>
{:else if isResolved}
	<!-- Expanded resolved card: the header row (title + status + caret) is the disclosure toggle -
	     tap anywhere on the header to recollapse (decision: not just a bare caret). Restore sits
	     below as its own control. Status color matches the collapsed line (decision: consistent
	     across collapse/expand). -->
	<article class="task-card task-card--resolved status-{item.status}">
		<button
			type="button"
			class="task-card__header"
			aria-expanded="true"
			onclick={() => (expanded = false)}
		>
			<span class="task-card__header-title">{item.def.title}</span>
			<span class="task-card__status">{STATUS_LABEL[item.status]}</span>
			{#if item.status === 'snoozed' && item.snoozeUntil}
				<span class="task-card__date">to {formatTimelineDate(item.snoozeUntil)}</span>
			{/if}
			<span class="caret" aria-hidden="true"></span>
		</button>
		<div class="task-card__detail">
			<p class="task-card__why">
				<span class="task-card__chip category-{item.def.category}"
					>{CATEGORY_LABEL[item.def.category]}</span
				>{item.def.why}
			</p>
			<!-- Decision B: a single unified Restore clears the stored status (un-mark / un-snooze). -->
			<div class="task-card__actions">
				<button type="button" onclick={() => onSetStatus(item.def.id, undefined)}>Restore</button>
				<button type="button" onclick={openNote}>{item.note ? 'Edit note' : 'Add note'}</button>
			</div>
			{@render noteSection()}
		</div>
	</article>
{:else}
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
				<button type="button" onclick={openNote}>{item.note ? 'Edit note' : 'Add note'}</button>
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
			{@render noteSection()}
		</div>
		<div class="task-card__meta">
			<span class="task-card__status">{STATUS_LABEL[item.status]}</span>
			<span class="task-card__date">{dateLine}</span>
		</div>
	</article>
{/if}

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

	/* Expanded resolved card stacks its header + detail vertically (overrides the open card's
	   two-column flex row). */
	.task-card--resolved {
		display: block;
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

	/* Inline note editor (C4 increment 4): a full-width textarea + Save/Cancel, styled like the
	   snooze inset (accent-bordered field; accent Save; quiet Cancel). */
	.task-card__note {
		margin-top: var(--space-s);
	}

	.task-card__note-input {
		width: 100%;
		min-height: 56px;
		resize: vertical;
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-s);
		padding: var(--space-s);
		font: inherit;
		font-size: var(--font-size-s);
	}

	.task-card__note-actions {
		display: flex;
		gap: var(--space-s);
		align-items: center;
		margin-top: var(--space-xs);
	}

	.task-card__note-save {
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

	.task-card__note-cancel {
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		font-size: var(--font-size-s);
		text-decoration: underline;
		cursor: pointer;
	}

	/* Saved note display (C4 increment 4): an inset panel under the why; small uppercase label. */
	.task-card__note-shown {
		margin-top: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
	}

	.task-card__note-label {
		display: block;
		margin-bottom: 2px;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.task-card__note-text {
		font-size: var(--font-size-s);
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

	/* Expanded resolved header: the disclosure toggle (button reset; full-width tap target). Title
	   left, status/date/caret right - one large click area to recollapse. */
	.task-card__header {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
	}

	.task-card__header-title {
		flex: 1;
		min-width: 0;
		font-size: var(--font-size-base);
		font-weight: 600;
		line-height: 1.3;
	}

	.task-card__detail {
		margin-top: var(--space-s);
	}

	/* Collapsed resolved line (C4 increment 3; timeline-states.html mockup): a thinner 2px status
	   edge vs the open card's 4px; one line of title (truncated) + status label + a right-caret. The
	   whole line is the disclosure control (button + aria-expanded); tapping expands the full card. */
	/* Note-dot on a collapsed resolved line: signals a note exists (expand to read it). */
	.task-line__note-dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent);
	}

	.task-line {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		text-align: left;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left-width: 2px;
		border-radius: var(--radius-m);
		padding: 6px var(--space-m);
		margin-bottom: var(--space-s);
		font: inherit;
		color: var(--color-fg);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
	}

	.task-line__title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.task-line__status {
		font-size: var(--font-size-s);
		font-weight: 600;
		white-space: nowrap;
	}

	.task-line__date {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		white-space: nowrap;
	}

	/* Per-status collapsed edge + label color (mockup ln-*): done = success green; skipped = muted +
	   dimmed; snoozed = muted with a dashed edge to read as "paused, not closed". */
	.line-done {
		border-left-color: var(--color-success);
	}
	.line-done .task-line__status {
		color: var(--color-success);
	}

	.line-skipped {
		border-left-color: var(--color-border);
		opacity: 0.65;
	}
	.line-skipped .task-line__status {
		color: var(--color-fg-muted);
	}

	.line-snoozed {
		border-left-color: var(--color-border);
		border-left-style: dashed;
	}
	.line-snoozed .task-line__status {
		color: var(--color-fg-muted);
	}

	/* Disclosure caret: right-pointing when collapsed, down (default) on the expanded card's
	   header toggle. */
	.caret {
		width: 0;
		height: 0;
		border-left: 4px solid transparent;
		border-right: 4px solid transparent;
		border-top: 5px solid var(--color-fg-muted);
	}

	.caret--right {
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		border-left: 5px solid var(--color-fg-muted);
		border-right: none;
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

	/* Status edge + label colors. Open states (C3): upcoming / start-now / overdue. Resolved states
	   (C4 inc 3): done / skipped / snoozed - colors MATCH the collapsed line so a status keeps its
	   color across collapse/expand (skipped stays full-opacity when expanded - you're reviewing it). */
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

	.status-done {
		border-left-color: var(--color-success);
	}
	.status-done .task-card__status {
		color: var(--color-success);
	}

	.status-skipped {
		border-left-color: var(--color-border);
	}
	.status-skipped .task-card__status {
		color: var(--color-fg-muted);
	}

	.status-snoozed {
		border-left-color: var(--color-border);
	}
	.status-snoozed .task-card__status {
		color: var(--color-fg-muted);
	}
</style>
