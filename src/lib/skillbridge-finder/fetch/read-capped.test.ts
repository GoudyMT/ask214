import { describe, it, expect } from 'vitest';
import { readCapped } from './read-capped';

/**
 * A body of `chunks` chunks that counts how often the reader pulled from it. A zero high-water mark means the
 * stream never reads ahead on its own, so the count is exactly what readCapped asked for.
 */
function countedBody(chunks: number, chunkBytes: number, headers: Record<string, string> = {}) {
	const seen = { pulls: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				seen.pulls += 1;
				if (seen.pulls > chunks) controller.close();
				else controller.enqueue(new Uint8Array(chunkBytes).fill(7));
			},
			cancel() {
				seen.cancelled = true;
			}
		},
		{ highWaterMark: 0 }
	);
	return { response: new Response(stream, { headers }), seen };
}

describe('readCapped', () => {
	// A hostile or broken server can stream without end: the phone must stop at the cap, not buffer the rest.
	it('stops pulling and cancels the source the moment the total passes the cap', async () => {
		const { response, seen } = countedBody(50, 40);
		await expect(readCapped(response, 100)).rejects.toThrow('E_SBF_TOO_LARGE');
		expect(seen.pulls).toBe(3);
		expect(seen.cancelled).toBe(true);
	});

	// The declared size is only a hint a server can lie about, so a small header must not lift the cap.
	it('still caps a body that is larger than its Content-Length says', async () => {
		const { response, seen } = countedBody(50, 40, { 'content-length': '10' });
		await expect(readCapped(response, 100)).rejects.toThrow('E_SBF_TOO_LARGE');
		expect(seen.pulls).toBe(3);
	});

	it('refuses a declared size over the cap without reading any of the body', async () => {
		const { response, seen } = countedBody(2, 60, { 'content-length': '101' });
		await expect(readCapped(response, 100)).rejects.toThrow('E_SBF_TOO_LARGE');
		expect(seen.pulls).toBe(0);
	});

	it('returns every byte of a body exactly at the cap and refuses one byte more', async () => {
		const atCap = await readCapped(countedBody(4, 25).response, 100);
		expect(atCap.length).toBe(100);
		expect([...atCap].every((b) => b === 7)).toBe(true);

		await expect(readCapped(countedBody(1, 101).response, 100)).rejects.toThrow('E_SBF_TOO_LARGE');
	});

	it('throws a static code when the response has no body', async () => {
		await expect(readCapped(new Response(null), 100)).rejects.toThrow('E_SBF_NO_BODY');
	});
});
