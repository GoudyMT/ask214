// Checks commit messages against the one-line format, in two modes. The rules live in the pure policy; this
// only reads messages, prints what is wrong and exits non-zero.
//
// File mode, run by the commit-msg git hook: `pnpm run check:commit-msg <message file>`. Git passes the path of
// the file holding the message it is about to record. The hook cannot see which cleanup git will apply, and
// git may remove `#` lines afterwards, so it drops them as the editor cleanup would and never refuses a message
// git would record correctly. It is an early warning: commits git makes itself (a cherry-pick, a revert, a
// squash) never run it, and neither does a checkout where the hooks were not installed.
//
// Range mode, run by CI and by hand: `pnpm run check:commits [range]` (default range: origin/main..HEAD). It
// reads each commit's message as git recorded it and checks it strictly, so it is the check that enforces.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findCommitMessageViolations } from '../src/lib/ci/commit-message-policy.ts';

const EXAMPLE = 'git commit -m "fix: hold the page still behind the open reader"';
const DEFAULT_RANGE = 'origin/main..HEAD';
// GitHub writes the bodies and sign-offs of the pull requests Dependabot opens, so nobody can shape them.
const SKIPPED_AUTHOR = 'dependabot[bot]';

/** @param {string} line The first line of a message, made safe to print into a log. */
function printable(line) {
	// Control characters could rewrite the terminal, and a line starting "::" is a command to the CI runner.
	return line.replace(/\p{Cc}/gu, '?');
}

/** @param {string} file */
function checkFile(file) {
	console.log('='.repeat(60));
	console.log('COMMIT MESSAGE');
	console.log('='.repeat(60));

	let raw;
	try {
		raw = readFileSync(file, 'utf-8');
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'unknown error');
		console.log('    The commit message file could not be read.');
		process.exit(1);
	}

	const violations = findCommitMessageViolations(raw, { stripComments: true });
	if (violations.length > 0) {
		for (const violation of violations) console.log(`    ${violation}`);
		console.log(`    One line, nothing else: ${EXAMPLE}`);
		console.log('\nCOMMIT MESSAGE REJECTED');
		process.exit(1);
	}
	console.log('    one line, right form');
	console.log('\nCOMMIT MESSAGE PASSED');
}

/** @param {string} range A git revision range. */
function checkRange(range) {
	let commits;
	try {
		// A merge commit is one nobody wrote: GitHub makes it to test a pull request, and git words it itself.
		commits = gitOutput(['rev-list', '--no-merges', range]).split('\n').filter(Boolean);
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'unknown error');
		console.log(`[check:commits] The commits in ${range} could not be listed.`);
		process.exit(1);
	}

	let skipped = 0;
	let offending = 0;
	for (const commit of commits) {
		// The author name and the message, split at the first NUL, which a message cannot hold.
		const [author = '', ...rest] = gitOutput(['log', '-1', '--format=%an%x00%B', commit]).split(
			'\0'
		);
		if (author === SKIPPED_AUTHOR) {
			skipped += 1;
			continue;
		}
		const message = rest.join('\0');
		const violations = findCommitMessageViolations(message, { stripComments: false });
		if (violations.length === 0) continue;

		offending += 1;
		const subject = printable(message.split('\n')[0] ?? '');
		console.error(`    ${commit.slice(0, 7)} ${subject}`);
		for (const violation of violations) console.error(`        ${violation}`);
	}

	console.log(
		`[check:commits] ${commits.length - skipped} commit message(s) checked in ${range}` +
			(skipped > 0 ? `, ${skipped} from ${SKIPPED_AUTHOR} skipped` : '')
	);
	if (offending > 0) {
		console.error(`    One line, nothing else: ${EXAMPLE}`);
		console.error(`[check:commits] ${offending} commit message(s) rejected`);
		process.exit(1);
	}
	console.log('[check:commits] OK: every message is one line, right form');
}

/** @param {string[]} args */
function gitOutput(args) {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

if (process.argv[2] === '--range') {
	checkRange(process.argv[3] ?? DEFAULT_RANGE);
} else if (process.argv[2] === undefined) {
	console.log('    The commit message file could not be read.');
	console.error('E_COMMIT_MESSAGE_NO_FILE');
	process.exit(1);
} else {
	checkFile(process.argv[2]);
}
