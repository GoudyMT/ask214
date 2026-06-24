import { describe, test, expect } from 'vitest';
import { backfillCaptureFields } from './backfill';

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
