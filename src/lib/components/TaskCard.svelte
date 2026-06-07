<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { TimelineItem, TaskCategory, DisplayStatus, TaskStatus } from '$lib/timeline';

	let {
		item,
		onSetStatus
	}: {
		item: TimelineItem;
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
	} = $props();

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
		</div>
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
	   mockup's action links). Snooze + Add note join here in later C4 increments. */
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
