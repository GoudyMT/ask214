/**
 * The rules the SkillBridge data Worker's config must keep. That Worker exists only to serve static files, and
 * the finder's "costs nothing, logs nothing" promise rests on it never running code: static asset requests are
 * free and never invoke a Worker unless the config adds a script, a binding or `run_worker_first`. The rules are
 * an allowlist, so a key nobody reviewed fails rather than slipping through. Read by a unit test against the
 * committed file and by the pre-deploy guard.
 */

export const DATA_WORKER_NAME = 'ask214-skillbridge-data';
export const DATA_ROUTE = { pattern: 'ask214.com/skillbridge-data/*', zone_name: 'ask214.com' };

const ALLOWED_KEYS = new Set([
	'$schema',
	'name',
	'compatibility_date',
	'observability',
	'assets',
	'routes',
	'workers_dev',
	'preview_urls'
]);

/**
 * Every rule the parsed config breaks; empty when it may be deployed.
 *
 * Args:
 *   config: the parsed `wrangler.jsonc` (comments stripped).
 *
 * Returns:
 *   One message per broken rule.
 */
export function findDataWorkerConfigViolations(config: Record<string, unknown>): string[] {
	const violations: string[] = [];
	for (const key of Object.keys(config))
		if (!ALLOWED_KEYS.has(key)) violations.push(`unreviewed key: ${key}`);

	if (config.name !== DATA_WORKER_NAME) violations.push('name');
	// Unset, these flip on: workers.dev turns on whenever no route is set, and observability defaults to on.
	if (config.workers_dev !== false) violations.push('workers_dev must be false');
	if (config.preview_urls !== false) violations.push('preview_urls must be false');
	const observability = config.observability;
	if (
		typeof observability !== 'object' ||
		observability === null ||
		JSON.stringify(observability) !== JSON.stringify({ enabled: false })
	)
		violations.push('observability must be exactly { enabled: false }');

	const assets = config.assets;
	if (
		typeof assets !== 'object' ||
		assets === null ||
		Object.keys(assets).join() !== 'directory' ||
		typeof (assets as { directory?: unknown }).directory !== 'string'
	)
		violations.push('assets must hold only a directory');

	if (JSON.stringify(config.routes) !== JSON.stringify([DATA_ROUTE]))
		violations.push('routes must be exactly the data path');

	return violations;
}
