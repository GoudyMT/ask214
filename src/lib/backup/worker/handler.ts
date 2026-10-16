import { argon2id } from '@noble/hashes/argon2.js';
import { HKDF_INFO_V1, KDF_V1 } from '../kdf-params';
import { parseCanonicalBytes } from '../phrase';
import { createSampler } from '../sampler';
import { isWorkerRequest } from './protocol';
import type { FromWorker, WorkerRequest } from './protocol';

/**
 * The backup key worker's logic, free of any worker scope so a test can drive it with plain calls.
 *
 * - Argon2id runs synchronously. Inside a dedicated worker, yielding to the event loop serves nothing: cancelling is
 *   `worker.terminate()`, which stops a busy worker, and `postMessage` from synchronous code still reaches the page,
 *   so progress still shows. The slow step is in a worker so the page stays responsive, not so it can be paused.
 * - The word-list check comes before the slow step. A mistyped word is the common failure, and it must cost the
 *   person nothing but the message; only a phrase made of list words earns the several seconds and 128 MiB of work.
 * - Only this worker may say NO_MEMORY. A RangeError on the page proves nothing about memory, but a RangeError from
 *   the one big allocation in Argon2id does, so the code is produced here and nowhere else.
 * - Accepted residuals: `worker.terminate()` does not wipe the memory noble used, and a CryptoKey cannot be zeroed.
 *   What can be wiped is wiped: the passphrase bytes on every path, and the Argon2id output once the key exists.
 * - Nothing here logs, reads an error's text or posts input. A failure is a code, and a word is only ever a position.
 */

// 128 MiB, so noble refuses anything above the v1 tuple instead of its 1 GiB default.
const MAXMEM = 134_217_728;
const POSITIONS = [1, 2, 3, 4, 5, 6] as const;

const WORKER_FAILED: FromWorker = { type: 'error', code: 'E_WORKER_FAILED' };

type DeriveRequest = Extract<WorkerRequest, { op: 'derive' }>;

function positionOf(index: number): (typeof POSITIONS)[number] {
	const position = POSITIONS[index];
	if (position === undefined) throw new Error('E_INTERNAL');
	return position;
}

// A refused request may still carry the passphrase buffer the page just gave away.
function wipePass(message: unknown): void {
	if (typeof message !== 'object' || message === null) return;
	const pass = (message as { pass?: unknown }).pass;
	if (pass instanceof ArrayBuffer) new Uint8Array(pass).fill(0);
}

// Usages are the least that does the job: a restore only opens, an export also opens its own file once to check it.
async function aesKeyFrom(
	output: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer>,
	purpose: DeriveRequest['purpose']
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO_V1) },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		purpose === 'restore' ? ['decrypt'] : ['encrypt', 'decrypt']
	);
}

export function createHandler(
	words: readonly string[],
	post: (msg: FromWorker) => void
): { handle: (message: unknown) => Promise<void> } {
	const wordSet: ReadonlySet<string> = new Set(words);

	async function derive(message: DeriveRequest): Promise<void> {
		const bytes = new Uint8Array(message.pass);
		try {
			const tokens = parseCanonicalBytes(bytes);
			// Canonical bytes can only be wrong through a bug on the page, never through what a person typed.
			if (tokens === null) {
				post(WORKER_FAILED);
				return;
			}
			const unknown = tokens.findIndex((token) => !wordSet.has(token));
			if (unknown !== -1) {
				post({ type: 'error', code: 'E_NOT_A_WORD', position: positionOf(unknown) });
				return;
			}

			let lastPercent = -1;
			let output: Uint8Array<ArrayBuffer>;
			try {
				// key and personalization are left out on purpose: noble reads an absent one as zero-length bytes,
				// the RFC's empty secret and empty associated data.
				output = argon2id(bytes, message.salt, {
					t: KDF_V1.t,
					m: KDF_V1.m,
					p: KDF_V1.p,
					version: KDF_V1.v,
					dkLen: KDF_V1.dkLen,
					maxmem: MAXMEM,
					onProgress: (fraction: number) => {
						const percent = Math.floor(fraction * 100);
						if (percent === lastPercent) return;
						lastPercent = percent;
						post({ type: 'progress', percent });
					}
				});
			} catch (e) {
				post({ type: 'error', code: e instanceof RangeError ? 'E_NO_MEMORY' : 'E_WORKER_FAILED' });
				return;
			}

			let key: CryptoKey;
			try {
				key = await aesKeyFrom(output, message.salt, message.purpose);
			} catch {
				post({ type: 'error', code: 'E_CRYPTO_FAILED' });
				return;
			} finally {
				output.fill(0);
			}
			post({ type: 'key', key });
		} finally {
			bytes.fill(0);
		}
	}

	async function handle(message: unknown): Promise<void> {
		try {
			if (!isWorkerRequest(message)) {
				wipePass(message);
				post(WORKER_FAILED);
				return;
			}
			if (message.op === 'generate') {
				post({ type: 'words', words: createSampler(words).generatePhrase() });
				return;
			}
			await derive(message);
		} catch {
			try {
				post(WORKER_FAILED);
			} catch {
				// The page cannot be reached from here; its own deadline reports the silence.
				return;
			}
		}
	}

	return { handle };
}
