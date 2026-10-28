/**
 * Ask the live site one public question and fail unless its online answers work.
 *
 * The app deploys itself on every push to main, but the retrieve Worker and its answer library deploy by hand.
 * A merge that moves the library version the app expects therefore breaks every online answer with nothing red
 * anywhere. This waits until the live build is from after the checked-out commit, then asks the question and
 * fails unless the answer comes from the library the commit's code accepts. The question is fixed and public, so
 * nothing personal is sent.
 *
 * Run: pnpm check:live    (CI runs it after each push to main and once a week)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	deployLanded,
	judgeAnswer,
	readAcceptedVersion,
	worthRetrying
} from './live-check-core.mjs';

const SITE = 'https://ask214.com';
const QUESTION = 'How do I apply for SkillBridge?';
const CODEC = 'src/lib/corpus/codec.ts';
// The host's build usually lands in a few minutes; past this the deploy itself has failed.
const DEPLOY_WAIT_MS = 20 * 60 * 1000;
const POLL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
// One retry: enough to ride out a blip, too few to hide a site that keeps failing.
const QUESTION_TRIES = 2;

/** @param {number} mergedAtMs The checked-out commit's time, in milliseconds. */
async function waitForDeploy(mergedAtMs) {
	const deadline = Date.now() + DEPLOY_WAIT_MS;
	for (;;) {
		// What this read showed, so a run that ends at the deadline names the right cause.
		let problem;
		try {
			// A fresh read every time: the stamp is cached by the browser normally, never here.
			const res = await fetch(`${SITE}/_app/version.json`, {
				cache: 'no-store',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (res.ok) {
				if (deployLanded(await res.text(), mergedAtMs)) return;
				problem = 'older';
				console.log('    The live build is older than this commit; waiting...');
			} else {
				problem = 'http';
				console.log(`    The build stamp answered HTTP ${res.status}; trying again...`);
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'E_LIVE_BAD_VERSION') throw err;
			// One dropped connection or slow answer is not an outage; the deadline decides.
			problem = 'network';
			console.log('    Could not reach the site; trying again...');
		}
		if (Date.now() > deadline) {
			if (problem === 'network') throw new Error('E_LIVE_NETWORK');
			if (problem === 'http') throw new Error('E_LIVE_VERSION_HTTP');
			throw new Error('E_LIVE_DEPLOY_TIMEOUT');
		}
		await sleep(POLL_MS);
	}
}

/** @returns {Promise<{ httpStatus: number, body: unknown }>} */
async function askQuestion() {
	let res;
	try {
		res = await fetch(`${SITE}/api/retrieve`, {
			method: 'POST',
			headers: { origin: SITE, 'content-type': 'application/json' },
			body: JSON.stringify({ query: QUESTION }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		throw new Error('E_LIVE_NETWORK');
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		// A non-JSON answer is judged on its status alone.
	}
	return { httpStatus: res.status, body };
}

/**
 * Asks the question and judges the answer, once more after a pause when the failure can clear by itself.
 *
 * @param {string} accepted The answer-library version the app accepts.
 */
async function askAndJudge(accepted) {
	for (let attempt = 1; ; attempt++) {
		try {
			const answer = await askQuestion();
			const body = /** @type {{ status?: unknown, corpusVersion?: unknown } | null} */ (
				answer.body
			);
			// JSON.stringify escapes line breaks, so a value from the server cannot pose as a runner command.
			console.log(`    HTTP ${answer.httpStatus}, answer ${JSON.stringify(body?.status ?? null)}`);
			console.log(
				`    Answer library: live ${JSON.stringify(body?.corpusVersion ?? null)}, expected ${accepted}`
			);
			judgeAnswer(answer, accepted);
			return;
		} catch (err) {
			const code = err instanceof Error ? err.message : 'E_LIVE_UNKNOWN';
			if (attempt >= QUESTION_TRIES || !worthRetrying(code)) throw err;
			console.log(`    ${code}; asking once more in ${POLL_MS / 1000} s...`);
			await sleep(POLL_MS);
		}
	}
}

async function main() {
	console.log('='.repeat(60));
	console.log('LIVE CHECK');
	console.log('='.repeat(60));
	const accepted = readAcceptedVersion(readFileSync(CODEC, 'utf8'));
	const mergedAtMs =
		Number(execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' })) * 1000;

	console.log('\n[1/2] Waiting for the live build to include this commit...');
	await waitForDeploy(mergedAtMs);

	console.log('[2/2] Asking the live server one public question...');
	await askAndJudge(accepted);
	console.log('    OK: online answers work and use the expected library');
}

await main();
