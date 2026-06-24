import { describe, test, expect } from 'vitest';
import { auditCopyRecord } from './audit-copy';

describe('auditCopyRecord', () => {
	test('builds a content-addressed path + integrity record for a pdf', async () => {
		const bytes = new TextEncoder().encode('hello');
		const r = await auditCopyRecord(bytes, 'pdf');
		expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(r.capturedPath).toBe(`content-ops/captures/${r.contentHash}.pdf`);
		expect(r.byteSize).toBe(5);
	});

	test('uses the html extension for an html source', async () => {
		const r = await auditCopyRecord(new TextEncoder().encode('<p>x</p>'), 'html');
		expect(r.capturedPath.endsWith('.html')).toBe(true);
	});
});
