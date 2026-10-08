import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runNodeWithDeadline } from './hook-unit-tests-core.mjs';

// The pre-commit hook starts its unit run with node itself, so no shim's sh stands between them, and the run is
// stopped and failed if it is still going at its deadline. These runs are real node processes, so the
// deadline and the stop are exercised, not described.
const TIMEOUT = 30_000;
// A run the stop never reaches has to fail an assertion, not run into the test's own time limit, so each wait is
// raced against LIMIT, well inside TIMEOUT. The hanging runs end by themselves after 20 s, past LIMIT, so only
// the stop can end them in time, and a broken stop leaves nothing running for long.
const LIMIT = 10_000;
const HANG = 'setTimeout(() => {}, 20_000)';

/** The run's outcome, or 'still running' when it has not ended within ms. */
async function outcomeWithin(run: Promise<{ outcome: string }>, ms: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<string>((settle) => {
		timer = setTimeout(() => settle('still running'), ms);
	});
	try {
		return await Promise.race([run.then((result) => result.outcome), late]);
	} finally {
		clearTimeout(timer);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!alive(pid)) return true;
		await new Promise((settle) => setTimeout(settle, 100));
	}
	return !alive(pid);
}

describe('runNodeWithDeadline', () => {
	it(
		'passes a run that ends with exit code 0',
		async () => {
			expect(await runNodeWithDeadline(['-e', 'process.exit(0)'], 10_000)).toEqual({
				outcome: 'passed',
				code: 0
			});
		},
		TIMEOUT
	);

	it(
		'fails a run that ends with any other exit code',
		async () => {
			expect(await runNodeWithDeadline(['-e', 'process.exit(1)'], 10_000)).toEqual({
				outcome: 'failed',
				code: 1
			});
		},
		TIMEOUT
	);

	it(
		'stops a run that is still going at its deadline and fails it',
		async () => {
			expect(await outcomeWithin(runNodeWithDeadline(['-e', HANG], 1_500), LIMIT)).toBe(
				'timed-out'
			);
		},
		TIMEOUT
	);

	// A hung vitest holds a browser and its workers. On Windows a node process's own children end with it, but a
	// process started through a shell does not, and one left that way holds the test port and fails the next
	// commit's run. So the run here starts its last process through cmd.exe, the shape that outlives a stop of
	// the run alone (measured), and the stop has to reach it.
	it.runIf(process.platform === 'win32')(
		'stops the processes the run started, also one started through a shell',
		async () => {
			// A run stopped mid-test (as when the hook itself is stopped) can still leave this folder behind.
			const scratch = mkdtempSync(join(tmpdir(), 'hook-unit-'));
			const parent = join(scratch, 'parent.cjs');
			const leaf = join(scratch, 'leaf.cjs');
			const pidFile = join(scratch, 'leaf.pid');
			writeFileSync(
				parent,
				[
					"const { spawn } = require('node:child_process');",
					'const [leaf, pidFile] = process.argv.slice(2);',
					'spawn(`"${process.execPath}" "${leaf}" "${pidFile}"`, { shell: true, stdio: "ignore" });',
					HANG
				].join('\n')
			);
			writeFileSync(
				leaf,
				`require('node:fs').writeFileSync(process.argv[2], String(process.pid));\n${HANG}\n`
			);
			const outcome = await outcomeWithin(
				runNodeWithDeadline([parent, leaf, pidFile], 4_000),
				LIMIT
			);
			let pid = 0;
			try {
				pid = Number(readFileSync(pidFile, 'utf8'));
				expect(outcome).toBe('timed-out');
				expect(await goneWithin(pid, 5_000)).toBe(true);
			} finally {
				if (pid > 0 && alive(pid)) process.kill(pid);
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		TIMEOUT
	);
});

describe('the hook', () => {
	// Through a shell-script shim (pnpm, node_modules/.bin/vitest) the run sits behind one more sh. Stopping the run
	// reads as a failure either way, but on Git for Windows stopping that sh reads as a pass, so the unit run is a
	// bare node line, and the only one.
	it('starts the unit run with node itself, and runs the unit suite no other way', () => {
		const lines = readFileSync(resolve('.husky/pre-commit'), 'utf8')
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== '' && !line.startsWith('#'));
		expect(lines).toContain('node content-ops/hook-unit-tests.mjs');
		expect(lines.filter((line) => line.includes('test:unit') || line.includes('vitest'))).toEqual(
			[]
		);
	});

	// The runner starts vitest's own entry rather than `pnpm run test:unit`, so that it holds the vitest process
	// itself and can stop it with everything it started. That is the same run only while the script is bare vitest.
	it('runs the same suite as `test:unit`', () => {
		const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['test:unit']).toBe('vitest');
	});
});
