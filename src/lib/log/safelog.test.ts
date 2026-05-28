import { describe, it, expect, beforeEach } from 'vitest';
import { safeLog, getDiagnosticsForTest, RING_BUFFER_SIZE } from './safelog';

describe('safeLog', () => {
	beforeEach(() => {
		// Test-only diagnostic reset; the public API exposes no clearing
		getDiagnosticsForTest().length = 0;
	});

	it('appends entries with opaque error codes', () => {
		safeLog({ code: 'E_EAOS_FORMAT' });
		const entries = getDiagnosticsForTest();
		expect(entries.length).toBe(1);
		expect(entries[0]?.code).toBe('E_EAOS_FORMAT');
	});

	it('accepts optional fields restricted to number | boolean | ErrorCode', () => {
		safeLog({
			code: 'E_KEYSTORE_HMAC_MISMATCH',
			fields: { generation: 5, hasSidecar: true, lastError: 'E_TIMEOUT' }
		});
		const entries = getDiagnosticsForTest();
		expect(entries[0]?.fields).toEqual({
			generation: 5,
			hasSidecar: true,
			lastError: 'E_TIMEOUT'
		});
	});

	it('bounds the ring buffer at RING_BUFFER_SIZE (oldest evicted)', () => {
		for (let i = 0; i < RING_BUFFER_SIZE + 5; i += 1) {
			safeLog({ code: 'E_TEST', fields: { i } });
		}
		const entries = getDiagnosticsForTest();
		expect(entries.length).toBe(RING_BUFFER_SIZE);
		expect(entries[0]?.fields?.i).toBe(5);
		expect(entries[entries.length - 1]?.fields?.i).toBe(RING_BUFFER_SIZE + 4);
	});

	// Rejecting raw Error is verified by the mtc/safelog-no-error ESLint rule.
	// This test asserts the runtime shape only.
});
