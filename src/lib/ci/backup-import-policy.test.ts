import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The root layout loads on every page, app-init is the code it runs at start-up, and the client hooks file runs before
// the app starts. The backup code (the session, the flows, the word list loader) is for the Settings and wizard pages
// alone: one import from any of these entries, however deep, would ship it to every page.
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ENTRIES = [
	join(SRC, 'routes/+layout.svelte'),
	join(SRC, 'lib/profile/app-init.ts'),
	join(SRC, 'hooks.client.ts')
];
const BACKUP = join(SRC, 'lib/backup') + sep;
// The backup files the shared chunk already carries, each a small leaf that imports nothing of the backup code:
// note-cap.ts is a single constant, kept in its own file so the note field and the timeline store can share it;
// intent.ts is the history note, which every page pays about 250 B gzip for, because the capture must run in the
// client init hook, before SvelteKit's start-up rewrites the history entry the note rides in.
const SHARED_LEAVES = [join(SRC, 'lib/backup/note-cap.ts'), join(SRC, 'lib/backup/intent.ts')];
// The shapes the other import scans read (src/lib/ci/pii-policy.ts): a static import or re-export, a side-effect
// import, `import(...)` with any quote including a template literal, and `import.meta.glob(...)`.
const IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\.meta\.glob(?:Eager)?\s*\(\s*\[?\s*|\bimport\s+)(['"`])([^'"`\r\n]+)\1/g;

function localFile(rawSpecifier: string, from: string): string | null {
	// A Vite suffix (`?raw`, `?worker`, `?url`) names the same file; left on, the file would not be found and a backup
	// import written that way would pass the scan.
	const specifier = rawSpecifier.split('?')[0] ?? rawSpecifier;
	let base: string;
	if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
	else if (specifier.startsWith('$lib/')) base = join(SRC, 'lib', specifier.slice('$lib/'.length));
	else return null;
	const stem = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;
	return (
		[base, `${base}.ts`, `${stem}.ts`, join(base, 'index.ts')].find(
			(path) => /\.(?:ts|svelte)$/.test(path) && existsSync(path)
		) ?? null
	);
}

/** Every source file the entries reach through local imports, the entries included. */
function reachable(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const queue = [...entries];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
			const next = localFile(match[2] ?? '', file);
			if (next !== null) queue.push(next);
		}
	}
	return seen;
}

describe('the root layout, app-init and the client hooks', () => {
	// Guards a real cost: these load on every page; a backup import there is paid by every visit.
	it('reach no file under src/lib/backup', () => {
		const reached = [...reachable(ENTRIES)]
			.filter((path) => path.startsWith(BACKUP) && !SHARED_LEAVES.includes(path))
			.map((path) => relative(SRC, path).split(sep).join('/'));
		expect(reached).toEqual([]);
	});

	// Guards a real cost: the SkillBridge plan's code (the answer reader, the write rules, the day math) is for the
	// Timeline and Settings routes, and the restore-only device reader is for the backup flows; the timeline store the
	// layout loads needs only the plan's key, which has a leaf file of its own. An import of either file from the layout's
	// graph would ship about 860 B gzip to Home, About, Documents, Feedback and Resources.
	it('reach neither the SkillBridge plan nor the device-state reader', () => {
		const reached = [...reachable(ENTRIES)]
			.map((path) => relative(SRC, path).split(sep).join('/'))
			.filter(
				(path) =>
					path === 'lib/timeline/skillbridge-plan.ts' || path === 'lib/profile/device-state.ts'
			);
		expect(reached).toEqual([]);
	});
});
