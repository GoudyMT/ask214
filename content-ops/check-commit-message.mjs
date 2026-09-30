// Run by the commit-msg git hook: `pnpm run check:commit-msg <message file>`. Git passes the path of the file
// holding the message it is about to record. The rules live in the pure policy, so this only reads the file,
// prints what is wrong and exits non-zero - which makes git refuse the commit.
import { readFileSync } from 'node:fs';
import { findCommitMessageViolations } from '../src/lib/ci/commit-message-policy.ts';

const EXAMPLE = 'git commit -m "fix: hold the page still behind the open reader"';

console.log('='.repeat(60));
console.log('COMMIT MESSAGE');
console.log('='.repeat(60));

const file = process.argv[2];
let raw;
try {
	if (file === undefined) throw new Error('E_COMMIT_MESSAGE_NO_FILE');
	raw = readFileSync(file, 'utf-8');
} catch (error) {
	console.error(error instanceof Error ? error.message : 'unknown error');
	console.log('    The commit message file could not be read.');
	process.exit(1);
}

const violations = findCommitMessageViolations(raw);
if (violations.length > 0) {
	for (const violation of violations) console.log(`    ${violation}`);
	console.log(`    One line, nothing else: ${EXAMPLE}`);
	console.log('\nCOMMIT MESSAGE REJECTED');
	process.exit(1);
}
console.log('    one line, right form');
console.log('\nCOMMIT MESSAGE PASSED');
