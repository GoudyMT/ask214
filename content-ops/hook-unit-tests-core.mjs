// The part of the pre-commit hook's unit run that tests can drive: a node run with a deadline. The entry script,
// hook-unit-tests.mjs, says why the hook needs it.
import { execFileSync, spawn } from 'node:child_process';

/** @typedef {{ outcome: 'passed' | 'failed' | 'timed-out'; code: number | null }} RunResult */

/**
 * Runs node with these arguments and waits for it; a run still going at the deadline is stopped and fails. The
 * code is the one node ended with, or null when a signal ended it.
 * @param {string[]} args
 * @param {number} deadlineMs
 * @returns {Promise<RunResult>}
 */
export function runNodeWithDeadline(args, deadlineMs) {
	return new Promise((settle) => {
		const child = spawn(process.execPath, args, { stdio: 'inherit' });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			stop(child.pid);
		}, deadlineMs);
		child.on('exit', (code) => {
			clearTimeout(timer);
			settle({ outcome: timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed', code });
		});
	});
}

/**
 * Stops a run and, on Windows, every process it started.
 * @param {number | undefined} pid
 */
function stop(pid) {
	if (pid === undefined) return;
	try {
		// On Windows a node process's own children end with it, but a process started through a shell does not,
		// and one left running holds the test port and fails the next commit's run. taskkill /T takes the whole
		// tree, however each process in it was started.
		if (process.platform === 'win32') {
			execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			process.kill(pid, 'SIGKILL');
		}
	} catch {
		// It ended on its own between the deadline and the stop.
	}
}

// Only staged code under these folders can be traced to the tests it touches. Anything else that is not prose
// (a config, the lockfile, a workflow a policy test reads) can move any test, so it runs the whole suite.
const TRACEABLE = /^(src|content-ops)\/.+\.(ts|js|mjs|cjs|svelte)$/;

/**
 * The vitest arguments for a commit's unit run: the tests related to its staged code, the whole suite when a
 * staged file can move every test, or null when nothing but prose is staged.
 * @param {string[]} staged repo-relative paths, forward slashes
 * @returns {string[] | null}
 */
export function unitRunFor(staged) {
	const files = staged.filter((file) => !file.endsWith('.md'));
	if (files.length === 0) return null;
	if (!files.every((file) => TRACEABLE.test(file))) return ['--run'];
	return ['related', '--run', ...files];
}
