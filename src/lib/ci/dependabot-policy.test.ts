import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// The app is finished and kept as it is (the owner, 2026-11-14): Dependabot sends security updates only. A
// routine version-update pull request every week is upkeep no one is on duty for, so every ecosystem keeps its
// version-update limit at 0. Security updates are a repository setting with their own fixed limit, so a 0 here
// does not stop them.

interface DependabotUpdate {
	'package-ecosystem': string;
	'open-pull-requests-limit'?: number;
}

describe('Dependabot policy: security updates only', () => {
	const config = parse(readFileSync(join(process.cwd(), '.github/dependabot.yml'), 'utf8')) as {
		updates: DependabotUpdate[];
	};

	it('turns version updates off for every ecosystem it lists', () => {
		expect(config.updates.length).toBeGreaterThan(0);
		for (const update of config.updates) {
			expect(update['open-pull-requests-limit'], update['package-ecosystem']).toBe(0);
		}
	});
});
