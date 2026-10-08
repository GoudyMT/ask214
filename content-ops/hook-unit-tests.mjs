// The pre-commit hook's unit run: vitest, started by this node process and stopped if it is still going at the
// deadline. Run from the repo root by .husky/pre-commit as `node content-ops/hook-unit-tests.mjs`.
//
// Started by node, not by `pnpm run test:unit`: on Git for Windows the hook is an sh script, and a command run
// through a shell-script shim (pnpm's, or node_modules/.bin/vitest) runs inside one more sh. Stopping the command
// itself (vitest, cmd.exe or pnpm's node) reads as a failure, as it should. Stopping that extra sh from outside
// (taskkill /F) reads as exit 0 to the hook, which carries on to the commit, each time it was measured. That is how
// a commit landed on 2026-10-08 with its unit run cut short. Started by node, the run has no extra sh, and stopping
// any process in it fails the hook (measured), so the hook line must stay a bare `node` command.
//
// Not closed: husky starts the hook script's own sh the same way, so stopping it (with /T that stops this run too)
// can still let the commit land, and stopping the sh behind a `pnpm` line above skips that step the same way. To
// stop a hung hook, stop the `git commit` process tree or this node process, never a shell in the chain, or let
// the deadline do it.
//
// The deadline: vitest's browser mode can hang (a client that cannot reach the test server, at no CPU), and a
// hung run left for a person to stop is how that stop happened. A run still going at the deadline is stopped with
// everything it started, and fails the commit.
import { resolve } from 'node:path';
import { runNodeWithDeadline } from './hook-unit-tests-core.mjs';

// Clean runs measured 20 to 158 s on this machine, the slow end under load; the hangs ran 10 to 30 minutes.
const DEADLINE_MS = 5 * 60_000;
const VITEST = resolve('node_modules/vitest/vitest.mjs');

const { outcome } = await runNodeWithDeadline([VITEST, '--run'], DEADLINE_MS);
if (outcome === 'timed-out') {
	console.error(
		`[test:unit] Still running after ${DEADLINE_MS / 60_000} minutes, so it was stopped with everything it started. That is well past a clean run, so it had most likely hung: commit again.`
	);
}
process.exit(outcome === 'passed' ? 0 : 1);
