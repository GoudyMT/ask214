import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guards the feedback endpoint's ONLY active abuse control. The handler fails OPEN when the binding is
// absent (`if (env.FEEDBACK_LIMITER)` - a guard kept so local dev works), so this test asserts the
// binding stays declared AND stays tight: a removal, a comment-out, `limit = 0`, or a loosening back
// toward the original ~60x drift can't silently ship. Comment lines are stripped first (a commented-out
// binding is functionally removed), and the limit MAGNITUDE is bounded (the drift that triggered the
// sweep was a too-loose limit, which a bare "limit exists" check would not catch).
const active = readFileSync(join(process.cwd(), 'wrangler.toml'), 'utf8')
	.split('\n')
	.filter((line) => !line.trimStart().startsWith('#'))
	.join('\n');

// Isolate the FEEDBACK_LIMITER binding's `simple = { ... }` block once, then read each field with a
// LITERAL regex at the call site. No dynamic `new RegExp` (the ReDoS linter flags a non-literal pattern,
// and `field` here was only ever the literal 'limit'/'period' anyway); the patterns stay hardcoded and
// auditable.
const simpleBlock =
	active.match(/name\s*=\s*"FEEDBACK_LIMITER"[\s\S]*?simple\s*=\s*\{([^}]*)\}/)?.[1] ?? '';

function fieldValue(pattern: RegExp): number | null {
	const m = simpleBlock.match(pattern);
	return m ? Number(m[1]) : null;
}

describe('feedback rate-limit binding stays configured + tight', () => {
	it('declares an uncommented FEEDBACK_LIMITER ratelimit', () => {
		expect(active).toMatch(/\[\[ratelimits\]\]/);
		expect(active).toMatch(/name\s*=\s*"FEEDBACK_LIMITER"/);
	});

	it('keeps the per-IP limit tight (1..10 per window)', () => {
		const limit = fieldValue(/\blimit\s*=\s*(\d+)/);
		expect(limit).not.toBeNull();
		expect(limit).toBeGreaterThanOrEqual(1);
		expect(limit).toBeLessThanOrEqual(10);
	});

	it('uses a Cloudflare-valid period (10 or 60 seconds)', () => {
		expect([10, 60]).toContain(fieldValue(/\bperiod\s*=\s*(\d+)/));
	});
});
