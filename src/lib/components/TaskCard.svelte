<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { TimelineItem, TaskCategory, DisplayStatus } from '$lib/timeline';

	let { item }: { item: TimelineItem } = $props();

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
			<span class="task-card__chip">{CATEGORY_LABEL[item.def.category]}</span>{item.def.why}
		</p>
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
