import { KDF_V1, SALT_BYTES } from '../backup/kdf-params';
import { KDF_WORKER_SRC } from '../backup/kdf-paths';
import { isWorkerAnswer } from '../backup/worker/protocol';
import type { FromWorker, PinRequest } from '../backup/worker/protocol';
import { KeystoreHmacMismatchError } from './read';

/**
 * The page's side of the PIN derive: it hands the PIN to the backup key worker and gets back the two keys of the app
 * lock. It belongs to the unlock and setup screens, which load on demand. The root layout must never import it, because
 * it pulls in the backup code (the backup import policy test pins that).
 */

// The derive takes about a second on a phone; a minute with no answer is a stuck or killed worker, never a long derive.
const PIN_DERIVE_DEADLINE_MS = 60_000;
const PIN_FORMAT = /^[0-9]{4,6}$/;

/** The device could not find the memory for the derive. Only the worker can tell; it says so with this code. */
export class PinNoMemoryError extends Error {
	constructor() {
		super('E_NO_MEMORY');
		this.name = 'PinNoMemoryError';
	}
}

/** Exactly 4 to 6 ASCII digits: the shape the worker accepts and the only one worth a derive. */
export function isPinFormat(pin: string): boolean {
	return PIN_FORMAT.test(pin);
}

/**
 * The parts of a Worker this module uses, so a test can stand in for one. It is the backup session's WorkerLike with
 * the PIN request in place of the backup requests: the session's type is fixed to those and reads `pass` from them.
 */
export type PinWorkerLike = {
	postMessage: (message: PinRequest, transfer?: Transferable[]) => void;
	terminate: () => void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessageerror: ((event: unknown) => void) | null;
};

function usagesAre(key: CryptoKey, sortedUsages: string): boolean {
	return [...key.usages].sort().join(',') === sortedUsages;
}

// The worker is another thread, so what it sends back is checked as it arrives: a key that could be exported, or that
// was made for another job, must never become a lock key.
function keysFit(macKey: CryptoKey, kek: CryptoKey): boolean {
	const mac = macKey.algorithm as KeyAlgorithm & { hash?: { name?: string }; length?: number };
	const wrap = kek.algorithm as KeyAlgorithm & { length?: number };
	return (
		macKey.type === 'secret' &&
		!macKey.extractable &&
		mac.name === 'HMAC' &&
		mac.hash?.name === 'SHA-256' &&
		mac.length === 256 &&
		usagesAre(macKey, 'sign,verify') &&
		kek.type === 'secret' &&
		!kek.extractable &&
		wrap.name === 'AES-KW' &&
		wrap.length === 256 &&
		usagesAre(kek, 'unwrapKey,wrapKey')
	);
}

function sameTuple(kdf: Readonly<Record<keyof typeof KDF_V1, number>>): boolean {
	return (
		kdf.v === KDF_V1.v &&
		kdf.m === KDF_V1.m &&
		kdf.t === KDF_V1.t &&
		kdf.p === KDF_V1.p &&
		kdf.dkLen === KDF_V1.dkLen
	);
}

function startWorker(): PinWorkerLike {
	return new Worker(KDF_WORKER_SRC, { type: 'module' }) as unknown as PinWorkerLike;
}

export async function derivePinKeys(
	pin: string,
	params: {
		kdf: Readonly<{ v: number; m: number; t: number; p: number; dkLen: number }>;
		salt: Uint8Array;
	},
	deps: { createWorker?: () => PinWorkerLike; onProgress?: (percent: number) => void } = {}
): Promise<{ macKey: CryptoKey; kek: CryptoKey }> {
	// Numbers other than the backup's, or a salt of the wrong size, mean the stored record is damaged. That is the same
	// failure as a record that fails its MAC, and never a wrong try, so it is checked before anything is derived.
	if (!sameTuple(params.kdf) || params.salt.length !== SALT_BYTES) {
		throw new KeystoreHmacMismatchError();
	}
	// Callers check the PIN first; this stops a bug from costing a derive.
	if (!isPinFormat(pin)) throw new Error('E_PIN_FORMAT');

	// The PIN is only ever digits, so one byte each; a text encoder would leave a second copy to wipe.
	const buffer = new ArrayBuffer(pin.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < pin.length; i++) bytes.set([pin.charCodeAt(i)], i);
	const salt = Uint8Array.from(params.salt);

	let worker: PinWorkerLike | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		try {
			worker = (deps.createWorker ?? startWorker)();
		} catch {
			// A worker that cannot start (a blocked script, no memory for a thread) is one more way the worker failed.
			throw new Error('E_WORKER_FAILED');
		}
		const live = worker;
		const reply = await new Promise<FromWorker>((resolve, reject) => {
			const failed = (): void => reject(new Error('E_WORKER_FAILED'));
			live.onmessage = (event) => {
				if (!isWorkerAnswer(event.data)) {
					failed();
					return;
				}
				if (event.data.type === 'progress') {
					deps.onProgress?.(event.data.percent);
					return;
				}
				resolve(event.data);
			};
			live.onmessageerror = failed;
			live.onerror = failed;
			timer = setTimeout(failed, PIN_DERIVE_DEADLINE_MS);
			try {
				live.postMessage({ op: 'derive-pin', pin: buffer, salt }, [buffer]);
			} catch {
				failed();
			}
		});
		if (reply.type === 'error') {
			throw reply.code === 'E_NO_MEMORY' ? new PinNoMemoryError() : new Error('E_WORKER_FAILED');
		}
		if (reply.type !== 'pin-keys') throw new Error('E_WORKER_FAILED');
		if (!keysFit(reply.macKey, reply.kek)) throw new Error('E_KEY_SHAPE');
		return { macKey: reply.macKey, kek: reply.kek };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		// After a transfer the page holds no copy (the buffer is detached, and filling it would throw over the result);
		// if the post failed, this buffer is the only copy and is wiped.
		if (buffer.byteLength > 0) bytes.fill(0);
		try {
			worker?.terminate();
		} catch {
			/* a worker that will not stop is still dropped */
		}
	}
}
