import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The commit message script has two modes: the hook reads the file git is about to record, and the range mode
// reads every message a branch carries as git recorded it. Both run for real here. The range mode runs against
// a throwaway repository whose hooks folder is empty, so the commits it holds are made without any hook.
const TSX = resolve('node_modules/tsx/dist/cli.mjs');
const SCRIPT = resolve('content-ops/check-commit-message.mjs');
const TIMEOUT = 30_000;
const TRAILER = 'Co-Authored-By: Someone <someone@example.com>';

// A hook run inside a git hook carries GIT_DIR and GIT_INDEX_FILE, which would send every git call here to the
// real repository, so nothing starting with GIT_ passes through; the user's own git config stays out too, by
// pointing git at an empty file.
let scratch = '';

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'commit-msg-'));
	writeFileSync(join(scratch, 'empty-config'), '');
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
	}
	return {
		...env,
		GIT_CONFIG_GLOBAL: join(scratch, 'empty-config'),
		GIT_CONFIG_NOSYSTEM: '1',
		...extra
	};
}

function runScript(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
	return spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
		cwd: options.cwd ?? process.cwd(),
		env: cleanEnv(options.env),
		encoding: 'utf8'
	});
}

describe('check-commit-message, file mode (the hook)', () => {
	function messageFile(name: string, text: string): string {
		const path = join(scratch, name);
		writeFileSync(path, text);
		return path;
	}

	it(
		'passes a message followed by a # line, which git removes',
		() => {
			const result = runScript([messageFile('hash', 'fix: x\n\n#42\n')]);
			expect(result.status, result.stdout).toBe(0);
			expect(result.stdout).toContain('COMMIT MESSAGE PASSED');
		},
		TIMEOUT
	);

	it(
		'passes the message of a conflicted cherry-pick: a valid line and the block git adds under it',
		() => {
			const text = 'fix: edit same on src\n\n# Conflicts:\n#\tsrc/a.ts\n';
			const result = runScript([messageFile('conflicts', text)], { env: { GIT_EDITOR: ':' } });
			expect(result.status, result.stdout).toBe(0);
		},
		TIMEOUT
	);

	it(
		'refuses a trailer',
		() => {
			const result = runScript([messageFile('trailer', `fix: x\n\n${TRAILER}\n`)]);
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('COMMIT MESSAGE REJECTED');
			expect(result.stdout).toContain('no body and no trailer');
		},
		TIMEOUT
	);

	it(
		'refuses a file it cannot read',
		() => {
			const result = runScript([join(scratch, 'missing')]);
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('could not be read');
		},
		TIMEOUT
	);
});

describe('check-commit-message, range mode', () => {
	let root = '';
	let hooks = '';
	let count = 0;

	beforeAll(() => {
		root = join(scratch, 'range');
		hooks = join(root, 'no-hooks');
		mkdirSync(hooks, { recursive: true });
	});

	function git(repo: string, ...args: string[]): string {
		return execFileSync('git', args, { cwd: repo, env: cleanEnv(), encoding: 'utf8' }).trim();
	}

	// A repository with one good commit on main, and no hook able to run in it.
	function makeRepo(): string {
		count += 1;
		const repo = join(root, `repo-${count}`);
		mkdirSync(repo);
		git(repo, 'init', '--quiet', '--initial-branch=main');
		git(repo, 'config', 'user.name', 'Test Author');
		git(repo, 'config', 'user.email', 'author@example.com');
		git(repo, 'config', 'commit.gpgsign', 'false');
		git(repo, 'config', 'core.hooksPath', hooks);
		git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'chore: start the repository');
		return repo;
	}

	function commit(repo: string, ...messages: string[]): string {
		git(repo, 'commit', '--quiet', '--allow-empty', ...messages.flatMap((m) => ['-m', m]));
		return git(repo, 'rev-parse', '--short=7', 'HEAD');
	}

	function check(repo: string, base: string) {
		return runScript(['--range', `${base}..HEAD`], { cwd: repo });
	}

	it(
		'passes a range whose commits are all one line',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			commit(repo, 'fix: hold the page still');
			commit(repo, 'chore(deps-dev): bump undici from 7.1.0 to 7.2.0');
			const result = check(repo, base);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('2 commit message(s) checked');
			expect(result.stdout).toContain('OK');
		},
		TIMEOUT
	);

	it(
		'refuses a commit with a trailer, names it, and leaves the good one unnamed',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const good = commit(repo, 'fix: hold the page still');
			const bad = commit(repo, 'fix: add the reader', TRAILER);
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${bad} fix: add the reader`);
			expect(result.stderr).toContain('The message must be one line, with no body and no trailer.');
			expect(result.stderr).not.toContain(good);
			expect(result.stderr).not.toContain('someone@example.com');
		},
		TIMEOUT
	);

	it(
		'refuses the message git records when `-m "fix: x" -m "#42"` is given, because #42 is a body',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const bad = commit(repo, 'fix: x', '#42');
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${bad} fix: x`);
		},
		TIMEOUT
	);

	it(
		'skips a commit authored by Dependabot, whose body GitHub writes',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			git(
				repo,
				'commit',
				'--quiet',
				'--allow-empty',
				'--author=dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
				'-m',
				'chore(deps): bump undici from 7.1.0 to 7.2.0',
				'-m',
				'Bumps undici.\n\nSigned-off-by: dependabot[bot] <support@github.com>'
			);
			const result = check(repo, base);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('0 commit message(s) checked');
			expect(result.stdout).toContain('1 from dependabot[bot] skipped');
		},
		TIMEOUT
	);

	it(
		'skips a merge commit, which no one wrote',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			git(repo, 'switch', '--quiet', '-c', 'side');
			commit(repo, 'fix: change the side');
			git(repo, 'switch', '--quiet', 'main');
			commit(repo, 'fix: change main');
			git(repo, 'merge', '--quiet', '--no-ff', 'side', '-m', "Merge branch 'side' into main");
			const result = check(repo, base);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('2 commit message(s) checked');
		},
		TIMEOUT
	);

	it(
		'reads origin/main..HEAD when no range is given: refuses a bad commit above it',
		() => {
			const repo = makeRepo();
			git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
			commit(repo, 'fix: add the reader', TRAILER);
			const result = runScript(['--range'], { cwd: repo });
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('origin/main..HEAD');
		},
		TIMEOUT
	);

	it(
		'passes with no commits to check when HEAD is origin/main, as on a push to main',
		() => {
			const repo = makeRepo();
			git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
			const result = runScript(['--range'], { cwd: repo });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('0 commit message(s) checked');
		},
		TIMEOUT
	);

	it(
		'refuses a range git cannot list',
		() => {
			const repo = makeRepo();
			const result = runScript(['--range', 'nothing-here..HEAD'], { cwd: repo });
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('could not be listed');
		},
		TIMEOUT
	);

	it(
		'prints a subject with a control character as a plain mark, not the character',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const escape = String.fromCharCode(0x1b);
			commit(repo, `::error::x${escape}[31m`);
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain(escape);
			expect(result.stderr).toContain('::error::x?[31m');
		},
		TIMEOUT
	);
});
