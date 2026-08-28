import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards the retrieve worker's per-client abuse control. The handler fails OPEN when the binding is
// absent (local dev), so this asserts the binding stays declared AND stays bounded: a removal, a
// comment-out, or a loosening toward "no real cap" can't silently ship. Comment lines are stripped
// first (a commented-out binding is functionally removed), and the limit magnitude is bounded.
const active = readFileSync(join(process.cwd(), 'workers/retrieve/wrangler.jsonc'), 'utf8')
	.split('\n')
	.filter((line) => !line.trimStart().startsWith('//'))
	.join('\n');

// Isolate the RETRIEVE_LIMITER's `simple` object once, then read each field with a LITERAL regex at
// the call site (no dynamic `new RegExp` - the ReDoS linter flags a non-literal pattern).
const simpleBlock = active.match(/"RETRIEVE_LIMITER"[\s\S]*?"simple"\s*:\s*\{([^}]*)\}/)?.[1] ?? '';

function fieldValue(pattern: RegExp): number | null {
	const m = simpleBlock.match(pattern);
	return m ? Number(m[1]) : null;
}

describe('retrieve rate-limit binding stays configured + bounded', () => {
	it('declares an uncommented RETRIEVE_LIMITER ratelimit', () => {
		expect(active).toMatch(/"ratelimits"/);
		expect(active).toMatch(/"name"\s*:\s*"RETRIEVE_LIMITER"/);
	});

	it('keeps the per-IP limit generous-but-bounded (1..30 per window)', () => {
		// Generous enough for shared / NAT origins (a base network), tight enough that one scripted IP
		// cannot flood the global neuron budget from a fast loop.
		const limit = fieldValue(/"limit"\s*:\s*(\d+)/);
		expect(limit).not.toBeNull();
		expect(limit).toBeGreaterThanOrEqual(1);
		expect(limit).toBeLessThanOrEqual(30);
	});

	it('uses a Cloudflare-valid period (10 or 60 seconds)', () => {
		expect([10, 60]).toContain(fieldValue(/"period"\s*:\s*(\d+)/));
	});
});
