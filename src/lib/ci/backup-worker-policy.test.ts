import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The key worker ships as its own file with its own copy of the word list. These hold the edges of that: the page
// must never carry the list (it is about 60 KB the page never needs), and the worker must never reach app code,
// because everything it reaches is bundled into a file that is vendored, hashed and served with no network access.
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(SRC, 'lib/backup/worker/entry.ts');
const WORDS = join(SRC, 'lib/backup/words-v1.ts');
// The same shapes the personal-data import scan reads (src/lib/ci/pii-policy.ts): a static import or re-export, a
// side-effect import, `import(...)` with any quote including a template literal, and `import.meta.glob(...)`.
const IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\.meta\.glob(?:Eager)?\s*\(\s*\[?\s*|\bimport\s+)(['"`])([^'"`\r\n]+)\1/g;

function importsOf(source: string): string[] {
	return [...source.matchAll(IMPORT)].map((match) => match[2] ?? '');
}

function isTestFile(path: string): boolean {
	return /\.(?:test|spec)\.ts$/.test(path);
}

function sourceFiles(folder: string): string[] {
	return readdirSync(folder, { recursive: true })
		.map((entry) => join(folder, String(entry)))
		.filter((path) => /\.(?:ts|svelte)$/.test(path) && !isTestFile(path));
}

/**
 * The source file a local specifier names, or null when it is not a local one (a package, or a file that is not
 * source). `$lib` is `src/lib`.
 */
function localFile(specifier: string, from: string): string | null {
	let base: string;
	if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
	else if (specifier.startsWith('$lib/')) base = join(SRC, 'lib', specifier.slice('$lib/'.length));
	else return null;
	// A `.js` specifier names the `.ts` file beside it, the way the bundler resolves it.
	const stem = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base;
	return (
		[base, `${base}.ts`, `${stem}.ts`, join(base, 'index.ts')].find(
			(path) => /\.(?:ts|svelte)$/.test(path) && existsSync(path)
		) ?? null
	);
}

function isLocal(specifier: string): boolean {
	return specifier.startsWith('.') || specifier.startsWith('$lib/');
}

describe('the backup word list', () => {
	it('only the worker entry imports words-v1', () => {
		const importers = sourceFiles(SRC).filter((path) =>
			importsOf(readFileSync(path, 'utf8')).some(
				(specifier) => localFile(specifier, path) === WORDS
			)
		);
		expect(importers.map((path) => relative(SRC, path).split(sep).join('/'))).toEqual([
			'lib/backup/worker/entry.ts'
		]);
	});
});

describe('the key worker graph', () => {
	/** Every file the entry reaches through local imports, the entry included. */
	function graph(): Map<string, string[]> {
		const reached = new Map<string, string[]>();
		const queue = [ENTRY];
		while (queue.length > 0) {
			const file = queue.pop() ?? '';
			if (reached.has(file)) continue;
			const specifiers = importsOf(readFileSync(file, 'utf8'));
			reached.set(file, specifiers);
			for (const specifier of specifiers) {
				const next = localFile(specifier, file);
				// A local import that names nothing readable would hide part of the graph, so it fails the walk.
				if (next === null && isLocal(specifier)) throw new Error('E_UNRESOLVED');
				if (next !== null) queue.push(next);
			}
		}
		return reached;
	}

	it('the worker entry does not import kdf-paths', () => {
		const reached = graph();
		expect(reached.size).toBeGreaterThan(1);
		for (const [file, specifiers] of reached) {
			expect(file, 'the graph reached kdf-paths').not.toMatch(/kdf-paths/);
			for (const specifier of specifiers) {
				expect(specifier, `${file} imports kdf-paths`).not.toMatch(/kdf-paths/);
			}
		}
	});

	it('the worker graph reaches nothing in src/routes, src/lib/components or a .svelte file', () => {
		const reached = graph();
		expect(reached.size).toBeGreaterThan(1);
		for (const [file, specifiers] of reached) {
			const where = relative(SRC, file).split(sep).join('/');
			expect(where, `${where} is app code`).not.toMatch(/^routes\/|^lib\/components\/|\.svelte$/);
			for (const specifier of specifiers) {
				expect(specifier, `${where} imports app code`).not.toMatch(/\.svelte|\$app|\$env/);
			}
		}
	});
});
