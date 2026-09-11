// Run from the repo root: `pnpm answer-gate:bge`, WITH the local embed worker running:
//
//   pnpm exec wrangler dev --config content-ops/bge-embed/wrangler.jsonc
//
// Scores the shipped short answer on the ONLINE path - the one `getDefaultMode()` returns for every device
// that has not opted out, so it is what most people actually get.
//
// WHY THE REAL SERVING AND NOT A LOCAL bge. A local `Xenova/bge-small-en-v1.5` through transformers.js is a
// PROXY for the model Workers AI serves, and the proxy is measurably optimistic: on this same index it
// scored 0.917/0.771 where the real serving scored 0.868/0.735. A gate that measures a proxy reports a
// number no user will ever experience. The embed worker exists for exactly this reason and is what
// build-corpus-bge.mjs and eval-corpus-bge.mjs already use.
//
// The measurement loop, the oracle, the junk scan and the bar are shared with the on-device gate, so the
// only things that differ here are the artifact, the embedder, and the cutoff.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCorpus } from '../src/lib/corpus/index.ts';
import { measureAnswers } from '../src/lib/ask/eval/measure-answer.ts';
import { runOracle, scanJunk, report } from './answer-gate-core.mjs';

// These MUST match workers/retrieve/src/index.ts, which is what serves production - a gate measuring
// different constants than the thing it guards measures nothing. bge is asymmetric: the QUERY carries the
// instruction prefix, the indexed passages do not.
const MODEL_ID = '@cf/baai/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const MIN_SCORE = 0.6;
const K = 5;
const LEAD_CARD_WORDS = 120;

const INDEX_DIR = 'content-ops/server-index';
const DEVICE_CORPUS_JSON = 'static/corpus/corpus-v1.0.1.json';
const QUERIES_PATH = 'src/lib/ask/eval/queries.json';
const EMBED_URL = process.env.BGE_EMBED_URL ?? 'http://127.0.0.1:8787';
const EMBED_ATTEMPTS = 3;
const EMBED_BACKOFF_MS = 400;

async function main() {
	console.log('='.repeat(66));
	console.log('ANSWER GATE - ONLINE PATH (bge-small, real Workers AI serving)');
	console.log('='.repeat(66));

	const manifest = JSON.parse(readFileSync(join(INDEX_DIR, 'corpus-v1.0.bge.json'), 'utf8'));
	const buf = readFileSync(join(INDEX_DIR, 'corpus-v1.0.bge.bin'));
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const corpus = decodeCorpus(manifest, ab, MODEL_ID);
	/** @type {{ query: string; sourceId?: string; answerSnippet?: string }[]} */
	const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
	const scoreable = queries.filter((q) => q.sourceId && q.answerSnippet);

	// The two paths must answer from the SAME words. They are built by different scripts from the same
	// cleaned corpus, so nothing but this check stops the server index from silently ageing behind the
	// on-device one and serving text the display rules were never measured against.
	const device = JSON.parse(readFileSync(DEVICE_CORPUS_JSON, 'utf8'));
	const serverHash = manifest.contentRevision?.contentHash;
	const deviceHash = device.contentRevision?.contentHash;
	if (serverHash === undefined || deviceHash === undefined || serverHash !== deviceHash) {
		console.error(
			`\nE_INDEX_PARITY: the server index and the on-device corpus are built from different content.` +
				`\n  server ${serverHash ?? 'missing'}\n  device ${deviceHash ?? 'missing'}` +
				`\nRebuild the server index (pnpm build:corpus-bge) before trusting this gate.`
		);
		process.exit(1);
	}

	console.log(
		`\n[1/4] Corpus ${corpus.chunks.length} chunks; scoreable queries ${scoreable.length}; content parity OK`
	);

	// The caller owns the prefix policy: passages were indexed verbatim, queries carry the prefix.
	//
	// Retried because the serving is remote: a single transient 5xx from Workers AI would otherwise abort a
	// run of 150+ queries and lose the whole measurement. Bounded and re-thrown on exhaustion, so a genuine
	// outage still fails the gate rather than being papered over.
	/** @param {string} text */
	const embed = async (text) => {
		for (let attempt = 1; attempt <= EMBED_ATTEMPTS; attempt++) {
			try {
				const res = await fetch(EMBED_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ texts: [QUERY_PREFIX + text] })
				});
				if (!res.ok) throw new Error('E_EMBED_HTTP');
				const data = await res.json();
				const v = data?.vectors?.[0];
				if (!Array.isArray(v)) throw new Error('E_EMBED_SHAPE');
				return Float32Array.from(v);
			} catch (err) {
				// Thrown codes stay static and opaque (mtc/no-input-in-error); the detail that makes a failure
				// diagnosable goes to the console instead, where the rule does not apply.
				console.error(`    embed attempt ${attempt}/${EMBED_ATTEMPTS} failed:`, err);
				if (attempt < EMBED_ATTEMPTS) {
					await new Promise((r) => setTimeout(r, EMBED_BACKOFF_MS * attempt));
				}
			}
		}
		throw new Error('E_EMBED_EXHAUSTED');
	};

	const metrics = await measureAnswers({
		corpus,
		queries,
		embed,
		minScore: MIN_SCORE,
		k: K,
		leadCardWords: LEAD_CARD_WORDS
	});

	const failures = report({
		label: 'online',
		metrics,
		leadCardWords: LEAD_CARD_WORDS,
		oracle: runOracle(corpus, scoreable),
		dirty: scanJunk(corpus),
		corpusSize: corpus.chunks.length
	});
	if (failures.length > 0) process.exit(1);
}

main();
