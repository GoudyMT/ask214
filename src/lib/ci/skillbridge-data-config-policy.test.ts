import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsoncComments } from './worker-config-policy';
import { findDataWorkerConfigViolations } from './skillbridge-data-config-policy';

const CONFIG_PATH = join(process.cwd(), 'workers', 'skillbridge-data', 'wrangler.jsonc');
const committed = () =>
	JSON.parse(stripJsoncComments(readFileSync(CONFIG_PATH, 'utf8'))) as Record<string, unknown>;

describe('the SkillBridge data Worker config', () => {
	it('as committed, serves static files only', () => {
		expect(findDataWorkerConfigViolations(committed())).toEqual([]);
	});

	// Each of these would make a request run code, log, bind a billable product, or answer on another host.
	it.each([
		['a script', { main: 'src/index.ts' }],
		['a KV binding', { kv_namespaces: [{ binding: 'X', id: 'y' }] }],
		['an R2 bucket', { r2_buckets: [{ binding: 'X', bucket_name: 'y' }] }],
		['a variable', { vars: { A: '1' } }],
		['code before assets', { assets: { directory: './deploy', run_worker_first: true } }],
		['an assets binding', { assets: { directory: './deploy', binding: 'ASSETS' } }],
		['workers.dev left on', { workers_dev: true }],
		['workers.dev unset', { workers_dev: undefined }],
		['preview links unset', { preview_urls: undefined }],
		['logs on', { observability: { enabled: false, logs: { enabled: true } } }],
		['a second route', { routes: [{ pattern: 'ask214.com/*', zone_name: 'ask214.com' }] }],
		['another name', { name: 'military-transition-companion' }]
	])('refuses %s', (_label, change) => {
		const config: Record<string, unknown> = { ...committed(), ...change };
		for (const [k, v] of Object.entries(config)) if (v === undefined) delete config[k];
		expect(findDataWorkerConfigViolations(config)).not.toEqual([]);
	});
});
