import { describe, it, expect } from 'vitest';
import { deriveChunkId } from './chunk-id';

describe('deriveChunkId', () => {
	it('formats the id as <sourceId>:<12 lowercase hex>', async () => {
		const id = await deriveChunkId('va_intent_to_file', 'Some chunk text.');
		expect(id).toMatch(/^[a-z0-9_]+:[0-9a-f]{12}$/);
		expect(id.startsWith('va_intent_to_file:')).toBe(true);
	});

	it('is STABLE under normalization-equivalent text (whitespace differences do not change the id)', async () => {
		const a = await deriveChunkId('va_x', 'Hello   world');
		const b = await deriveChunkId('va_x', 'Hello world');
		expect(a).toBe(b);
	});

	it('yields a different (diffMerge-detectable) id when the text changes', async () => {
		const a = await deriveChunkId('va_x', 'Hello world');
		const b = await deriveChunkId('va_x', 'Hello there');
		expect(a).not.toBe(b);
	});

	it('yields a different id for the same text under a different source', async () => {
		const a = await deriveChunkId('va_x', 'Hello world');
		const b = await deriveChunkId('va_y', 'Hello world');
		expect(a).not.toBe(b);
	});
});
