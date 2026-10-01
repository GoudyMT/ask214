// Checks commit messages against the one-line format, in two modes. The rules live in the pure policy; this
// only reads messages, prints what is wrong and exits non-zero.
//
// File mode, run by the commit-msg git hook: `pnpm run check:commit-msg <message file>`. Git passes the path of
// the file holding the message it is about to record. The hook cannot see which cleanup git will apply, and
// git may remove `#` lines afterwards, so it drops them as the editor cleanup would; with git's default comment
// character it does not refuse a message git would record correctly (another `core.commentChar` can make it
// disagree with git either way). It also cannot tell whether git keeps a `#` line given with a second `-m`, so
// those are left to the range check. While a merge is in progress it lets through a one-line message that starts
// with `Merge`, as git words its own, because the range check skips merges. It is an early warning: commits git
// makes itself (a cherry-pick, a revert, a squash) never run it, and neither does a checkout where the hooks
// were not installed.
//
// Range mode, run by CI and by hand: `pnpm run check:commits [range]` (default range: origin/main..HEAD). It
// reads each commit's message as git recorded it and checks it strictly, so it is the check that enforces. It
// skips merge commits and Dependabot's commits, and it does not see the commit that lands on main, which is
// written when the pull request is merged.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
	FORMAT_VIOLATION,
	findCommitMessageViolations
} from '../src/lib/ci/commit-message-policy.ts';

const EXAMPLE = 'git commit -m "fix: hold the page still behind the open reader"';
const DEFAULT_RANGE = 'origin/main..HEAD';
const STALE_NOTE =
	'[check:commits] A commit named above that is already on main means origin/main is stale: run "git fetch origin" and check again.';
// GitHub writes the bodies and sign-offs of the pull requests Dependabot opens, so nobody can shape them.
const SKIPPED_AUTHOR = 'dependabot[bot]';

/** @param {string} line The first line of a message, made safe to print into a log. */
function printable(line) {
	// Control, invisible and direction-changing characters could rewrite or hide what the terminal shows. The CI
	// runner reads "##[" as a command anywhere in a line, so it is broken up; a leading "::" is already blocked
	// by the commit hash the line is printed after.
	return line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?').replaceAll('##[', '# #[');
}

/** @returns {boolean} True when a merge is in progress in the current repository. */
function mergeInProgress() {
	try {
		// The file git itself looks for, not `rev-parse --verify MERGE_HEAD`, which also resolves a tag or a
		// branch of that name.
		const path = gitOutput(['rev-parse', '--git-path', 'MERGE_HEAD']).trim();
		return existsSync(path);
	} catch {
		return false;
	}
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
	// The message git words for a merge it is making (`git merge`, a pull that diverged, a commit that ends a
	// conflicted merge) is not written by a person, and the range check skips merge commits, so the hook does
	// not refuse it either. It passes only when the form is its one fault: one clean line, then at most the
	// comment lines git adds. A body or a trailer on a merge would be read by no check, so those stay refused,
	// which includes the log body git adds with `merge.log` or `--log` (off by default).
	if (
		violations.length === 1 &&
		violations[0] === FORMAT_VIOLATION &&
		raw.startsWith('Merge ') &&
		mergeInProgress()
	) {
		console.log('    merge message written by git');
		console.log('\nCOMMIT MESSAGE PASSED');
		return;
	}
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
		// Merge commits are left out: GitHub makes one to test a pull request, and git words the ones it makes
		// itself. That also skips a merge a person makes on a branch, which is rare here since branches squash.
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
		// A squash commit already on main is named here only when the local origin/main is behind.
		console.error(STALE_NOTE);
		process.exit(1);
	}
	console.log('[check:commits] OK: every message is one line, right form');
}

/** @param {string[]} args */
function gitOutput(args) {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

if (process.argv[2] === '--range') {
	// A caller may put a `--` before the range, as when the script is run directly; the pnpm this project pins
	// drops it before the script sees it.
	const rangeArg = process.argv[3] === '--' ? process.argv[4] : process.argv[3];
	checkRange(rangeArg ?? DEFAULT_RANGE);
} else if (process.argv[2] === undefined) {
	console.log('    The commit message file could not be read.');
	console.error('E_COMMIT_MESSAGE_NO_FILE');
	process.exit(1);
} else {
	checkFile(process.argv[2]);
}
