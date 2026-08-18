import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsoncComments, findWorkerConfigViolations } from './worker-config-policy';

const WORKER_CONFIG = join(process.cwd(), 'workers', 'retrieve', 'wrangler.jsonc');
const WORKER_SOURCE = join(process.cwd(), 'workers', 'retrieve', 'src', 'index.ts');

describe('stripJsoncComments', () => {
	it('strips a // line comment', () => {
		expect(stripJsoncComments('{\n\t"a": 1 // note\n}')).toBe('{\n\t"a": 1 \n}');
	});

	it('strips a /* block */ comment', () => {
		expect(stripJsoncComments('{ /* x */ "a": 1 }')).toBe('{  "a": 1 }');
	});

	it('preserves // that appears inside a string value', () => {
		// A naive strip would corrupt a URL; the real wrangler config has schema-relative paths.
		const raw = '{ "url": "https://ask214.com/*" }';
		expect(stripJsoncComments(raw)).toBe(raw);
		expect(JSON.parse(stripJsoncComments(raw)).url).toBe('https://ask214.com/*');
	});

	it('yields JSON.parse-able output for a commented config', () => {
		const raw = '{\n\t// lead comment\n\t"observability": { "enabled": false }\n}';
		expect(JSON.parse(stripJsoncComments(raw))).toEqual({ observability: { enabled: false } });
	});

	it('strips a trailing comma before a closing brace or bracket', () => {
		// Trailing commas are legal JSONC but JSON.parse rejects them; the real config could gain one.
		expect(JSON.parse(stripJsoncComments('{ "a": 1, }'))).toEqual({ a: 1 });
		expect(JSON.parse(stripJsoncComments('{ "a": [1, 2, ] }'))).toEqual({ a: [1, 2] });
	});

	it('does not strip a comma inside a string value', () => {
		expect(JSON.parse(stripJsoncComments('{ "a": "x," }')).a).toBe('x,');
	});
});

describe('findWorkerConfigViolations', () => {
	it('flags observability enabled', () => {
		const v = findWorkerConfigViolations({ observability: { enabled: true } });
		expect(v.some((m) => m.includes('observability'))).toBe(true);
	});

	it('flags observability absent (must be explicitly disabled, not left to the platform default)', () => {
		expect(findWorkerConfigViolations({}).some((m) => m.includes('observability'))).toBe(true);
	});

	it('flags a tail consumer', () => {
		const v = findWorkerConfigViolations({
			observability: { enabled: false },
			tail_consumers: [{ service: 'x' }]
		});
		expect(v.some((m) => m.includes('tail_consumers'))).toBe(true);
	});

	it('flags an analytics engine binding', () => {
		const v = findWorkerConfigViolations({
			observability: { enabled: false },
			analytics_engine_datasets: [{ binding: 'AE' }]
		});
		expect(v.some((m) => m.includes('analytics_engine_datasets'))).toBe(true);
	});

	it('flags logpush enabled', () => {
		const v = findWorkerConfigViolations({ observability: { enabled: false }, logpush: true });
		expect(v.some((m) => m.includes('logpush'))).toBe(true);
	});

	it('passes a compliant config', () => {
		expect(findWorkerConfigViolations({ observability: { enabled: false } })).toEqual([]);
	});

	it('flags nested observability.logs enabled (a query would still reach edge logs)', () => {
		const v = findWorkerConfigViolations({
			observability: { enabled: false, logs: { enabled: true } }
		});
		expect(v.some((m) => m.includes('observability'))).toBe(true);
	});

	it('flags nested observability.traces enabled', () => {
		const v = findWorkerConfigViolations({
			observability: { enabled: false, traces: { enabled: true } }
		});
		expect(v.some((m) => m.includes('observability'))).toBe(true);
	});
});

describe('the committed retrieve-Worker holds ADR-025 item 7', () => {
	it('the real wrangler.jsonc has no observability/telemetry violations', () => {
		const config = JSON.parse(stripJsoncComments(readFileSync(WORKER_CONFIG, 'utf8')));
		expect(findWorkerConfigViolations(config)).toEqual([]);
	});

	it('the Worker never routes the embed through AI Gateway', () => {
		// "no AI Gateway" is a call-site property: it lives in the AI.run(...) options, not the
		// config. A gateway route logs the prompt (the user query) by default, so guard the source.
		const source = readFileSync(WORKER_SOURCE, 'utf8');
		// Catch the unquoted `gateway:` run() option and the quoted "gateway": key, plus a raw fetch
		// to the AI Gateway host (which would bypass the AI binding entirely).
		expect(source).not.toMatch(/\bgateway["']?\s*:/i);
		expect(source).not.toMatch(/gateway\.ai\.cloudflare\.com/i);
	});
});
