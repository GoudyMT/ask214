import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The root layout loads on every page, and app-init is the code it runs at start-up. The backup code (the session,
// the flows, the word list loader) is for the Settings and wizard pages alone: one import from either entry, however
// deep, would ship it to every page.
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ENTRIES = [join(SRC, 'routes/+layout.svelte'), join(SRC, 'lib/profile/app-init.ts')];
const BACKUP = join(SRC, 'lib/backup') + sep;
// The one backup file the shared chunk already carries: a single constant that imports nothing, kept in its own file
// so the note field and the timeline store can share it without the rest of the backup code.
const SHARED_LEAF = join(SRC, 'lib/backup/note-cap.ts');
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

describe('the root layout and app-init', () => {
	// Guards a real cost: the layout node is on every page; a backup import there is paid by every visit.
	it('reach no file under src/lib/backup', () => {
		const reached = [...reachable(ENTRIES)]
			.filter((path) => path.startsWith(BACKUP) && path !== SHARED_LEAF)
			.map((path) => relative(SRC, path).split(sep).join('/'));
		expect(reached).toEqual([]);
	});
});
