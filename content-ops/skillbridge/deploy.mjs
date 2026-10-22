// Max's weekly deploy of the SkillBridge data files. Run it from the data Worker's own folder, so the app's
// Worker config at the repo root can never be the one wrangler finds:
//
//   cd "<repo>/workers/skillbridge-data"
//   node --import tsx "<repo>/content-ops/skillbridge/deploy.mjs"
//
// (`pnpm --dir <repo> exec tsx ...` starts in the repo root, which the guard refuses with E_APP_ROOT.) The guard
// checks the config and the tree first and prints codes only; wrangler runs only when nothing is wrong, from the
// data Worker's folder, with its own config. Wrangler uses Max's own login (`wrangler login --use-keyring`
// with narrowed scopes); no token is read or stored here.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataConfigPath, guardAndDeploy } from './guard-core.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Every entry under `dir` with its path relative to it, seen with lstat so a symlink is reported and never followed.
 * Throws when `dir` does not exist, which the guard reports as E_NO_TREE.
 * @param {string} dir
 * @returns {{ path: string, bytes: number, isFile: boolean, isSymlink: boolean }[]}
 */
function listTree(dir) {
	/** @type {{ path: string, bytes: number, isFile: boolean, isSymlink: boolean }[]} */
	const out = [];
	const root = lstatSync(dir);
	if (root.isSymbolicLink()) {
		out.push({ path: '.', bytes: 0, isFile: false, isSymlink: true });
		return out;
	}
	/** @param {string} rel */
	const walk = (rel) => {
		for (const name of readdirSync(rel === '' ? dir : join(dir, rel))) {
			const path = rel === '' ? name : `${rel}/${name}`;
			const stat = lstatSync(join(dir, path));
			out.push({
				path,
				bytes: stat.size,
				isFile: stat.isFile(),
				isSymlink: stat.isSymbolicLink()
			});
			if (stat.isDirectory()) walk(path);
		}
	};
	walk('');
	return out;
}

/**
 * Starts a program from a file and an argument list, never through a shell, and shows its output as it comes.
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string }} options
 * @returns {Promise<number>}
 */
function runner(file, args, options) {
	// The guard only ever asks for node running wrangler's script; anything else is refused here too.
	if (file !== process.execPath) return Promise.reject(new Error('E_RUNNER_FILE'));
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: options.cwd,
			shell: false,
			stdio: 'inherit'
		});
		child.on('error', reject);
		child.on('close', (code) => resolve(code ?? 1));
	});
}

const wranglerPackage = createRequire(import.meta.url).resolve('wrangler/package.json');

console.log('guard: checking the data Worker config and the deploy tree');
const outcome = await guardAndDeploy(
	{
		repoRoot,
		cwd: process.cwd(),
		env: process.env,
		exists: existsSync,
		readText: (path) => readFileSync(path, 'utf8'),
		listTree,
		runner,
		wranglerJs: join(dirname(wranglerPackage), 'bin', 'wrangler.js'),
		nodePath: process.execPath
	},
	{ configPath: dataConfigPath(repoRoot) }
);

if (!outcome.ok && outcome.exitCode === undefined) {
	console.log('refused');
	for (const problem of outcome.problems) console.log(problem);
	process.exit(1);
}
console.log(outcome.ok ? 'deployed' : 'wrangler failed');
process.exit(outcome.exitCode ?? 1);
