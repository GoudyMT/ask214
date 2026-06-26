import { describe, test, expect } from 'vitest';
import { backfillCaptureFields, resolveBackfill } from './backfill';

describe('backfillCaptureFields', () => {
	test('sets the four capture fields, preserves existing fields, does not mutate the input', () => {
		const entry = { source_id: 'va_x', content_type: 'html' } as Record<string, unknown>;
		const out = backfillCaptureFields(entry, {
			contentHash: 'h1',
			capturedPath: 'content-ops/captures/h1.html',
			capturedAt: '2026-06-22T00:00:00Z',
			robotsAllowed: true
		});
		expect(out).toMatchObject({
			source_id: 'va_x',
			content_type: 'html',
			content_hash: 'h1',
			captured_path: 'content-ops/captures/h1.html',
			captured_at: '2026-06-22T00:00:00Z',
			robots_allowed: true
		});
		expect('content_hash' in entry).toBe(false); // input untouched
	});
});

describe('resolveBackfill', () => {
	// Injected timestamp keeps the idempotency tests deterministic (no Date mocking).
	const incoming = { contentHash: 'abc123', contentType: 'html' } as const;
	const NOW = '2026-06-25T12:00:00.000Z';

	test('a new source (no recorded hash) stamps captured_at = now', () => {
		expect(resolveBackfill({}, incoming, NOW)).toEqual({
			contentHash: 'abc123',
			capturedPath: 'content-ops/captures/abc123.html',
			capturedAt: NOW,
			robotsAllowed: true
		});
	});

	test('an unchanged hash keeps the existing captured_at (idempotent no-op)', () => {
		const r = resolveBackfill(
			{ content_hash: 'abc123', captured_at: '2026-06-01T00:00:00.000Z' },
			incoming,
			NOW
		);
		expect(r.capturedAt).toBe('2026-06-01T00:00:00.000Z');
	});

	test('a changed hash refreshes captured_at = now', () => {
		const r = resolveBackfill(
			{ content_hash: 'OLDHASH', captured_at: '2026-06-01T00:00:00.000Z' },
			incoming,
			NOW
		);
		expect(r.capturedAt).toBe(NOW);
	});

	test('a matching hash but missing captured_at still stamps now', () => {
		// partial prior backfill: the hash is recorded but the timestamp never landed -> stamp it now
		expect(resolveBackfill({ content_hash: 'abc123' }, incoming, NOW).capturedAt).toBe(NOW);
	});

	test('derives captured_path from hash + content_type (pdf)', () => {
		const r = resolveBackfill({}, { contentHash: 'deadbeef', contentType: 'pdf' }, NOW);
		expect(r.capturedPath).toBe('content-ops/captures/deadbeef.pdf');
	});

	test('robots_allowed is always true (a disallowed source fails closed at capture)', () => {
		expect(resolveBackfill({}, incoming, NOW).robotsAllowed).toBe(true);
	});
});
