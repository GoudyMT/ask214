<script lang="ts">
	import { formatTimelineDate, formatDaysLeft } from '$lib/timeline/format-date';
	import { SNOOZE_DATE_MAX, SNOOZE_PRESETS, snoozeUntilIso } from '$lib/timeline/snooze';
	import type { TimelineItem, TaskCategory, DisplayStatus, TaskStatus } from '$lib/timeline';
	import { resourcesForTask, afterLinkForTask, linkNoteForTask } from '$lib/resources';
	import { isFirmWarning, type FitReason } from '$lib/timeline/generate';

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

	// Resolved tasks (done/skipped/snoozed) collapse to a one-line disclosure.
	// Expansion is ephemeral local state (collapse state is never stored).
	let expanded = $state(false);
	const isResolved = $derived(
		item.status === 'done' || item.status === 'skipped' || item.status === 'snoozed'
	);

	// Auto-collapse on any status transition (mark done/skip/snooze, or restore -> re-resolve): a
	// resolved card lands collapsed by default; expanding is the deliberate action. A plain toggle
	// does not change item.status, so manual expand/collapse is preserved. prevStatus starts
	// undefined (NOT snapshotting the prop) so there is no spurious reset on mount. An open Snooze picker closes
	// too: its presets may no longer apply to the new status.
	let prevStatus = $state<DisplayStatus | undefined>(undefined);
	$effect(() => {
		if (prevStatus !== undefined && item.status !== prevStatus) {
			expanded = false;
			closeSnooze();
		}
		prevStatus = item.status;
	});

	function snooze(days: number): void {
		onSetSnooze(item.def.id, snoozeUntilIso(new Date(), days));
		closeSnooze();
	}

	// The earliest custom date is tomorrow, read when the field opens and again at the tap. A snooze is live only while
	// its date is after today, so today and the past would be stored and then ignored.
	let dateInput = $state<HTMLInputElement>();

	function snoozeToDate(): void {
		// The day can turn while the picker is open, so the minimum is read again here and set on the field at once, before
		// the browser checks the date against its min and max (a year of five digits is past the max). A refused date
		// stays, with the browser's own reason and focus on the field.
		if (!dateInput) return;
		dateInput.min = snoozeUntilIso(new Date(), 1);
		if (!dateInput.reportValidity()) return;
		onSetSnooze(item.def.id, dateValue);
		closeSnooze();
	}

	function closeSnooze(): void {
		snoozeOpen = false;
		showDateInput = false;
		dateValue = '';
	}

	// Inline note editor: Add/Edit note -> textarea (prefilled with any existing
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

	// Contextual outbound resources: the links curated for this specific task, collapsed by default.
	const related = $derived(resourcesForTask(item.def.id));
	const linkNote = $derived(linkNoteForTask(item.def.id));
	let relatedOpen = $state(false);

	const STATUS_LABEL: Record<DisplayStatus, string> = {
		upcoming: 'Upcoming',
		'start-now': 'Start now',
		'closing-soon': 'Closing soon',
		late: 'Late',
		changed: 'Changed',
		closed: 'Closed',
		'still-to-do': 'Still to do',
		done: 'Done',
		skipped: 'Skipped',
		snoozed: 'Snoozed',
		'after-you-leave': 'After you leave'
	};

	const CATEGORY_LABEL: Record<TaskCategory, string> = {
		medical: 'Medical',
		admin: 'Admin',
		benefits: 'Benefits',
		career: 'Career',
		finance: 'Finance'
	};

	// The reason Fit moved a date, said on that date only.
	const REASON: Record<FitReason, string> = {
		skillbridge: 'before SkillBridge',
		'terminal-leave': 'before terminal leave'
	};
	const AFTER_YOU_LEAVE_NOTE =
		'This opens after you leave your command. Ask your command how to fit it in.';

	// The date line by status: when a window opens, a soft task's aim, a firm task's last day, when a passed date
	// was due. Resolved states use the collapsed treatment instead.
	const firm = $derived(item.def.kind !== 'soft');
	const dateLine = $derived.by((): { text: string; reason?: string } => {
		const f = formatTimelineDate;
		const at = (label: string, iso: string) => ({
			text: `${label} ${f(iso)}`,
			...(item.fit && iso === item.fit.date ? { reason: REASON[item.fit.reason] } : {})
		});
		switch (item.status) {
			case 'upcoming':
			case 'after-you-leave':
				return { text: `Opens ${f(item.windowStartDate)}` };
			case 'start-now':
				return firm
					? at('Last day', item.windowEndDate)
					: at('Aim for', item.aimDate ?? item.windowEndDate);
			case 'closing-soon':
				return at('Last day', item.windowEndDate);
			case 'late':
				return at('was due', item.windowEndDate);
			case 'changed':
				return { text: `Last day ${f(item.finalEndDate ?? item.windowEndDate)}` };
			case 'closed':
				return { text: f(item.finalEndDate ?? item.windowEndDate) };
			case 'still-to-do':
				return at('Aimed for', item.windowEndDate);
			default:
				return { text: f(item.targetDate) };
		}
	});

	const daysLeftLine = $derived(item.daysLeft === undefined ? '' : formatDaysLeft(item.daysLeft));

	// After a firm date: what is still possible (late, closed), or what changed at a two-edge task's first edge. A
	// required task closes only after separation, when its note about doing it first no longer applies.
	const afterNote = $derived(
		item.status === 'after-you-leave'
			? { label: 'What now', text: AFTER_YOU_LEAVE_NOTE }
			: item.status === 'changed'
				? { label: 'What changed', text: item.def.changeNote }
				: item.status === 'late' || (item.status === 'closed' && item.def.kind === 'closes')
					? { label: 'What now', text: item.def.afterNote }
					: undefined
	);
	// The one official page to go to from that box (curated per firm task).
	const afterLink = $derived(afterNote ? afterLinkForTask(item.def.id) : undefined);
</script>

{#snippet noteSection()}
	{#if noteOpen}
		<div class="task-card__note">
			<textarea
				class="task-card__note-input"
				bind:value={noteValue}
				spellcheck="false"
				aria-label="Note"
				placeholder="Add a note..."></textarea>
			<div class="task-card__note-actions">
				<button type="button" class="task-card__note-save" onclick={saveNote}>Save</button>
				<button type="button" class="task-card__note-cancel" onclick={closeNote}>Cancel</button>
			</div>
		</div>
	{:else if item.note}
		<div class="task-card__note-shown">
			<span class="task-card__note-label">Notes</span>
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
				>
				{item.def.why}
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
	<!-- tabindex -1: the "Needs you now" rows jump here, and the card must be able to take that focus. -->
	<article
		class="task-card status-{item.status}"
		class:task-card--calm={item.status === 'after-you-leave' && !firm}
		id="task-{item.def.id}"
		tabindex="-1"
	>
		<div class="task-card__body">
			<h3 class="task-card__title">{item.def.title}</h3>
			<p class="task-card__why">
				<span class="task-card__chip category-{item.def.category}"
					>{CATEGORY_LABEL[item.def.category]}</span
				>
				{#if firm}<span class="task-card__firm">Firm deadline</span>{/if}
				{item.def.why}
			</p>
			{#if afterNote?.text}
				<div class="task-card__whatnow">
					<span class="task-card__whatnow-label">{afterNote.label}</span>
					{afterNote.text}
					{#if afterLink}
						<br />
						<a
							class="task-card__whatnow-link"
							href={afterLink.url}
							target="_blank"
							rel="noopener noreferrer external"
							>{afterLink.label}<span aria-hidden="true"> &#8599;</span><span
								class="visually-hidden"
							>
								(opens in a new tab)</span
							></a
						>
					{/if}
				</div>
			{/if}
			<div class="task-card__actions">
				<button type="button" onclick={() => onSetStatus(item.def.id, 'done')}>Mark done</button>
				<button type="button" onclick={() => onSetStatus(item.def.id, 'skipped')}>Skip</button>
				<!-- A snooze never hides a firm warning, so it is not offered where it would change nothing. -->
				{#if !isFirmWarning(item.status, item.def.kind)}
					<button type="button" onclick={() => (snoozeOpen = !snoozeOpen)}>Snooze</button>
				{/if}
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
							<input
								type="date"
								autocomplete="off"
								bind:this={dateInput}
								bind:value={dateValue}
								min={snoozeUntilIso(new Date(), 1)}
								max={SNOOZE_DATE_MAX}
								aria-label="Snooze until date"
							/>
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
			{#if related.length > 0}
				<div class="task-card__related">
					<button
						type="button"
						class="task-card__related-toggle"
						aria-expanded={relatedOpen}
						onclick={() => (relatedOpen = !relatedOpen)}
					>
						Related resources ({related.length})
						<span class="caret" class:caret--right={!relatedOpen} aria-hidden="true"></span>
					</button>
					{#if relatedOpen}
						{#if linkNote}<p class="task-card__related-note">{linkNote}</p>{/if}
						<ul class="task-card__related-list">
							{#each related as r (r.id)}
								<li>
									<a href={r.url} target="_blank" rel="noopener noreferrer external">
										{r.title}<span aria-hidden="true"> &#8599;</span><span class="visually-hidden">
											(opens in a new tab)</span
										>
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</div>
		<div class="task-card__meta">
			<span class="task-card__status">{STATUS_LABEL[item.status]}</span>
			<span class="task-card__when"
				><span class="task-card__date"
					>{dateLine.text}{#if dateLine.reason}<span class="task-card__reason"
							>, <span class="task-card__reason-words">{dateLine.reason}</span></span
						>{/if}</span
				>{#if daysLeftLine}<span class="task-card__days">{daysLeftLine}</span>{/if}</span
			>
		</div>
	</article>
{/if}

<style>
	/* Open status card (timeline-states.html mockup): a surface panel with a
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
		/* An anchor target below the sticky header + chip strip, like the phase sections. */
		scroll-margin-top: 6.5rem;
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

	/* The space after each tag in the markup is the gap between them, so a screen reader reads them apart. */
	.task-card__chip {
		display: inline-block;
		padding: 1px 6px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* "Firm deadline": danger-outlined, so a closing date is visible long before it nears. */
	.task-card__firm {
		display: inline-block;
		padding: 1px 6px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 50%, transparent);
		border-radius: var(--radius-s);
		color: var(--color-danger);
		font-size: var(--font-size-s);
		white-space: nowrap;
	}

	/* overflow-wrap: a long word breaks inside the box instead of spilling past its edge on a phone. */
	.task-card__whatnow {
		margin-top: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		font-size: var(--font-size-s);
		overflow-wrap: anywhere;
	}

	/* The same small uppercase label as the "Needs you now" group headings. */
	.task-card__whatnow-label {
		display: block;
		margin-bottom: 2px;
		color: var(--color-fg-muted);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.task-card__whatnow-link {
		display: inline-block;
		margin-top: var(--space-xs);
		color: var(--color-accent);
		text-decoration: none;
	}

	.task-card__whatnow-link:hover {
		text-decoration: underline;
	}

	/* Action row: accent pills that wrap. Real <button>s for a11y; the pill shape matches the snooze
	   preset pills that open inside this same card, so the card speaks one consistent pill language. */
	.task-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
		margin-top: var(--space-s);
	}

	.task-card__actions button {
		/* Bordered pill; min-height is the 44px touch target. flex-wrap on the row (not a single no-wrap
		   line) is what keeps the actions from overflowing a ~320px screen - a pill that will not fit drops
		   to the next line. white-space keeps each label on one line so a pill never wraps internally. */
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

	.task-card__actions button:hover {
		border-color: var(--color-accent);
	}

	/* Inline snooze picker (Option B): preset pills + a "Customize" date input,
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

	/* color-scheme follows the active theme, so the browser draws the native glyph to match the
	   current surface (matches the EAOS date field). Do NOT invert it - see EaosInput. */
	.task-card__date-row input::-webkit-calendar-picker-indicator {
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

	/* Inline note editor: a full-width textarea + Save/Cancel, styled like the
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
		transition: box-shadow 120ms ease;
	}

	.task-card__note-input:focus {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 30%, transparent);
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

	/* Saved note display: an inset panel under the why; small uppercase label. */
	.task-card__note-shown {
		margin-top: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		overflow-wrap: anywhere; /* a pasted address wraps instead of spilling past the box */
	}

	.task-card__note-label {
		display: block;
		margin-bottom: 2px;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
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

	.task-card__when {
		display: block;
	}

	.task-card__days {
		display: block;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* On a phone the right-hand status column would leave the text a sliver, so the status line (status, date,
	   countdown) moves above the title as one wrapping line and the text takes the card's full width. The
	   480px breakpoint is the one the header and the Ask view use. */
	@media (max-width: 480px) {
		/* stretch: every row is the card's width, never the width of its longest word. */
		.task-card {
			flex-direction: column;
			align-items: stretch;
			gap: var(--space-xs);
		}

		.task-card__meta {
			order: -1;
			text-align: left;
			white-space: normal;
		}

		.task-card__meta .task-card__status,
		.task-card__meta .task-card__when,
		.task-card__meta .task-card__days {
			display: inline;
		}

		/* The line may break only after the status's dash: the date and its countdown move as one, so no line
		   starts with "- 17 days". \00a0 is a no-break space. */
		.task-card__meta .task-card__status::after {
			content: '\00a0- ';
		}

		.task-card__meta .task-card__when {
			white-space: nowrap;
		}

		.task-card__meta .task-card__days::before {
			content: '\00a0-\00a0';
		}

		/* A moved date's reason may start the next line, kept whole and joined to its countdown: the one break
		   the date line allows is the space after the date's comma. */
		.task-card__meta .task-card__reason {
			white-space: normal;
		}
	}

	.task-card__reason-words {
		white-space: nowrap;
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

	/* Collapsed resolved line (timeline-states.html mockup): a thinner 2px status
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

	/* Per-status collapsed edge + label color: done = success green; skipped = muted edge + label at
	   full opacity (the text must clear WCAG AA); snoozed = muted with a dashed edge to read as
	   "paused, not closed". */
	.line-done {
		border-left-color: var(--color-success);
	}
	.line-done .task-line__status {
		color: var(--color-success);
	}

	.line-skipped {
		border-left-color: var(--color-border);
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

	/* Category chip colors (Option C): soft-filled tag - colored text + low-opacity
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

	/* Status edge + label colors. Open states: upcoming / start-now / closing-soon / late / changed /
	   closed / still-to-do. Resolved states:
	   done / skipped / snoozed - colors MATCH the collapsed line so a status keeps its
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

	.status-closing-soon,
	.status-late,
	.status-changed {
		border-left-color: var(--color-danger);
	}
	.status-closing-soon .task-card__status,
	.status-late .task-card__status,
	.status-changed .task-card__status,
	.status-closed .task-card__status {
		color: var(--color-danger);
	}

	/* Closed: the date has passed for good - a dashed edge reads "ended", not "act now". */
	.status-closed {
		border-left-color: var(--color-danger);
		border-left-style: dashed;
	}

	/* Still to do: a soft task past its window - calm, not red; it can still be done. */
	.status-still-to-do {
		border-left-color: var(--color-accent-muted);
		border-left-style: dashed;
	}
	.status-still-to-do .task-card__status {
		color: var(--color-accent-muted);
	}

	/* After you leave: a firm task that opens after the user leaves the command - dotted, "needs a word with your
	   command", not "closed". A soft one takes the calm Still-to-do look: good timing only. */
	.status-after-you-leave {
		border-left-color: var(--color-danger);
		border-left-style: dotted;
	}
	.status-after-you-leave .task-card__status {
		color: var(--color-danger);
	}
	.task-card--calm.status-after-you-leave {
		border-left-color: var(--color-accent-muted);
		border-left-style: dashed;
	}
	.task-card--calm.status-after-you-leave .task-card__status {
		color: var(--color-accent-muted);
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

	/* Contextual outbound resources: a collapsed disclosure under the open card body; the toggle
	   reuses the card's accent-link style + the shared caret. */
	.task-card__related {
		margin-top: var(--space-s);
	}

	.task-card__related-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 0;
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
		touch-action: manipulation;
	}

	.task-card__related-toggle:hover {
		text-decoration: underline;
	}

	/* A line the links cannot hold, read before them. */
	.task-card__related-note {
		margin: var(--space-xs) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.task-card__related-list {
		list-style: none;
		margin: var(--space-xs) 0 0;
		padding: 0;
	}

	.task-card__related-list li {
		padding: 2px 0;
	}

	.task-card__related-list a {
		color: var(--color-accent);
		text-decoration: none;
		font-size: var(--font-size-s);
	}

	.task-card__related-list a:hover {
		text-decoration: underline;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
