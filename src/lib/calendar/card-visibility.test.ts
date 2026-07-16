import { describe, it, expect } from 'vitest';
import { shouldShowCalendarCard, CARD_COOLDOWN_MS, CARD_MAX_DISMISSALS } from './card-visibility';

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

describe('shouldShowCalendarCard', () => {
	it('shows when the card has never been dismissed', () => {
		expect(shouldShowCalendarCard({}, NOW)).toBe(true);
	});

	it('hides during the cooldown window after a dismissal', () => {
		const justDismissed = { dismissedAt: NOW - 1000, dismissCount: 1 };
		expect(shouldShowCalendarCard(justDismissed, NOW)).toBe(false);

		const almostElapsed = { dismissedAt: NOW - (CARD_COOLDOWN_MS - 1), dismissCount: 1 };
		expect(shouldShowCalendarCard(almostElapsed, NOW)).toBe(false);
	});

	it('re-shows once the cooldown has elapsed', () => {
		const elapsed = { dismissedAt: NOW - CARD_COOLDOWN_MS, dismissCount: 1 };
		expect(shouldShowCalendarCard(elapsed, NOW)).toBe(true);
	});

	it('goes quiet for good once the dismissal cap is reached, however old the dismissal', () => {
		const capped = { dismissedAt: NOW - CARD_COOLDOWN_MS * 100, dismissCount: CARD_MAX_DISMISSALS };
		expect(shouldShowCalendarCard(capped, NOW)).toBe(false);
	});
});
