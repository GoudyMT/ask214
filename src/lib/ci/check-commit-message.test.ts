import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
let root = '';
let hooks = '';
let count = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'commit-msg-'));
	writeFileSync(join(scratch, 'empty-config'), '');
	root = join(scratch, 'repos');
	hooks = join(root, 'no-hooks');
	mkdirSync(hooks, { recursive: true });
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

function git(repo: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd: repo, env: cleanEnv(), encoding: 'utf8' }).trim();
}

// A repository with one good commit on main, and no hook able to run in it. It must be the repository the
// helper says it is: a git call that fell through to the real one would commit into it.
function makeRepo(): string {
	count += 1;
	const repo = join(root, `repo-${count}`);
	mkdirSync(repo);
	git(repo, 'init', '--quiet', '--initial-branch=main');
	expect(realpathSync(git(repo, 'rev-parse', '--absolute-git-dir'))).toBe(
		realpathSync(join(repo, '.git'))
	);
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

describe('the environment the script runs in', () => {
	it('drops every GIT_ variable of the caller, so a git call cannot reach the real repository', () => {
		const before = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
		process.env.GIT_DIR = join(scratch, 'not-a-repository');
		process.env.GIT_INDEX_FILE = join(scratch, 'fake-index');
		try {
			const child = spawnSync(
				process.execPath,
				['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'],
				{ env: cleanEnv(), encoding: 'utf8' }
			);
			const keys = (JSON.parse(child.stdout) as string[]).map((key) => key.toUpperCase());
			expect(keys).not.toContain('GIT_INDEX_FILE');
			expect(keys).not.toContain('GIT_DIR');
			expect(keys).toContain('GIT_CONFIG_GLOBAL');
			// With the fake variables in this process, git in a throwaway repository still finds its own.
			const repo = makeRepo();
			expect(realpathSync(git(repo, 'rev-parse', '--absolute-git-dir'))).toBe(
				realpathSync(join(repo, '.git'))
			);
		} finally {
			if (before.dir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = before.dir;
			if (before.index === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = before.index;
		}
	});
});

describe('check-commit-message, file mode (the hook)', () => {
	function messageFile(name: string, text: string): string {
		const path = join(scratch, name);
		writeFileSync(path, text);
		return path;
	}

	// A repository in the middle of `git merge --no-commit`, with the message git wrote for it.
	function mergeInProgress(): { repo: string; mergeMessage: string } {
		const repo = makeRepo();
		git(repo, 'switch', '--quiet', '-c', 'side');
		commit(repo, 'fix: change the side');
		git(repo, 'switch', '--quiet', 'main');
		commit(repo, 'fix: change main');
		git(repo, 'merge', '--quiet', '--no-ff', '--no-commit', 'side');
		const mergeMessage = readFileSync(
			join(repo, git(repo, 'rev-parse', '--git-path', 'MERGE_MSG')),
			'utf8'
		);
		return { repo, mergeMessage };
	}

	it(
		'passes the message git writes for a merge in progress, as the range check skips merges',
		() => {
			const { repo, mergeMessage } = mergeInProgress();
			expect(mergeMessage.startsWith('Merge ')).toBe(true);
			const text = `${mergeMessage}\n# Conflicts:\n#\tsrc/a.ts\n`;
			const result = runScript([messageFile('merge', text)], { cwd: repo });
			expect(result.status, result.stdout).toBe(0);
			expect(result.stdout).toContain('COMMIT MESSAGE PASSED');
		},
		TIMEOUT
	);

	it(
		'still refuses a message that is not git merge wording while a merge is in progress',
		() => {
			const { repo } = mergeInProgress();
			const result = runScript([messageFile('merge-other', 'Add the thing\n')], { cwd: repo });
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('COMMIT MESSAGE REJECTED');
		},
		TIMEOUT
	);

	it(
		'refuses merge wording when no merge is in progress',
		() => {
			const repo = makeRepo();
			const result = runScript([messageFile('merge-none', "Merge branch 'side'\n")], { cwd: repo });
			expect(result.status).toBe(1);
			expect(result.stdout).toContain('COMMIT MESSAGE REJECTED');
		},
		TIMEOUT
	);

	it(
		'passes a line that ends with extra carriage returns, which git trims in an editor flow',
		() => {
			const result = runScript([messageFile('cr', 'fix: x\r\r\n')]);
			expect(result.status, result.stdout).toBe(0);
		},
		TIMEOUT
	);

	it(
		'passes a message followed by a # line, which git removes when an editor is used',
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

const DEPENDABOT_AUTHOR = 'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>';
const STALE_LINE =
	'[check:commits] A commit named above that is already on main means origin/main is stale: run "git fetch origin" and check again.';

describe('check-commit-message, range mode', () => {
	function check(repo: string, base: string) {
		return runScript(['--range', `${base}..HEAD`], { cwd: repo });
	}

	// GitHub writes the body and the sign-off of a pull request Dependabot opens, so the message is not one line.
	function dependabotCommit(repo: string): void {
		git(
			repo,
			'commit',
			'--quiet',
			'--allow-empty',
			`--author=${DEPENDABOT_AUTHOR}`,
			'-m',
			'chore(deps): bump undici from 7.1.0 to 7.2.0',
			'-m',
			'Bumps undici.\n\nSigned-off-by: dependabot[bot] <support@github.com>'
		);
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
			dependabotCommit(repo);
			const result = check(repo, base);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('0 commit message(s) checked');
			expect(result.stdout).toContain('1 from dependabot[bot] skipped');
		},
		TIMEOUT
	);

	it(
		'keeps reading past a Dependabot commit: the oldest of three is bad, the newest good',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const bad = commit(repo, 'fix: add the reader', TRAILER);
			dependabotCommit(repo);
			const good = commit(repo, 'fix: hold the page still');
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${bad} fix: add the reader`);
			expect(result.stderr).not.toContain(good);
			expect(result.stdout).toContain('2 commit message(s) checked');
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

	it(
		'prints a subject so that no part of it is a command to the CI runner, wherever it stands in the line',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			commit(repo, 'Fix: ##[error]boom ###[warning]x');
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain('##[');
			expect(result.stderr).toContain('Fix: # #[error]boom ## #[warning]x');
		},
		TIMEOUT
	);

	it(
		'prints a bidi override or a line separator in a subject as a plain mark',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const override = String.fromCharCode(0x202e);
			const separator = String.fromCharCode(0x2028);
			commit(repo, `Fix: a${override}b${separator}c`);
			const result = check(repo, base);
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain(override);
			expect(result.stderr).not.toContain(separator);
			expect(result.stderr).toContain('Fix: a?b?c');
		},
		TIMEOUT
	);

	it(
		'ends a refusal with the line that says a stale origin/main can name a commit already on main',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			commit(repo, 'fix: add the reader', TRAILER);
			const result = check(repo, base);
			expect(result.status).toBe(1);
			const lines = result.stderr.trimEnd().split('\n');
			expect(lines.at(-1)).toBe(STALE_LINE);
			expect(lines.filter((line) => line === STALE_LINE)).toHaveLength(1);
		},
		TIMEOUT
	);

	it(
		'does not mention a stale origin/main when every message is fine',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			commit(repo, 'fix: hold the page still');
			const result = check(repo, base);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stderr).not.toContain('git fetch origin');
			expect(result.stdout).not.toContain('git fetch origin');
		},
		TIMEOUT
	);

	it(
		'reads the range that follows a literal -- , as `pnpm run check:commits -- <range>` passes it',
		() => {
			const repo = makeRepo();
			const base = git(repo, 'rev-parse', 'HEAD');
			const bad = commit(repo, 'fix: add the reader', TRAILER);
			const result = runScript(['--range', '--', `${base}..HEAD`], { cwd: repo });
			expect(result.status).toBe(1);
			expect(result.stdout).not.toContain('could not be listed');
			expect(result.stdout).toContain(`in ${base}..HEAD`);
			expect(result.stderr).toContain(bad);
		},
		TIMEOUT
	);

	it(
		'reads the default range when only a literal -- follows',
		() => {
			const repo = makeRepo();
			git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
			const result = runScript(['--range', '--'], { cwd: repo });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain('origin/main..HEAD');
		},
		TIMEOUT
	);
});
