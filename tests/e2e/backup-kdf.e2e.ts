import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildBackupAad } from '../../src/lib/backup/aad';
import { readBackupFile } from '../../src/lib/backup/envelope';
import { GOLDEN_PASSWORD } from '../../src/lib/backup/golden/golden';
import { HKDF_INFO_V1 } from '../../src/lib/backup/kdf-params';
import { KDF_WORKER_SRC } from '../../src/lib/backup/kdf-paths';
import {
	KAT_ARGON2_HEX,
	KAT_PASSWORD,
	KAT_PIN,
	KAT_PIN_FULL,
	KAT_PIN_MAC_MESSAGE,
	KAT_PIN_WRAPPED_KEY,
	KAT_SALT
} from '../../src/lib/backup/kdf-kat';

// The only place the real Argon2id runs at the production tuple (128 MiB, 4 passes, 2 lanes), inside the built and
// served key worker. Every unit test replaces that step, so without this spec a change to the worker, the noble
// build or the HKDF step could move the key and still pass. It is not tagged @slow: it is the gate that keeps the
// backup format from drifting, so it runs in CI on both engines, never in the commit hook.
//
// Each test makes one derive, in the page. On a developer desktop that took about 1.4 s in Chromium and 2.3 s in
// WebKit, and a slower CI runner needs more, which the 90 s limit leaves room for. No time is asserted; each
// engine's derive time is written to the test's annotations, and WebKit's is labelled a proxy for Safari.
test.setTimeout(90_000);

const GOLDEN_FILE = new URL('../../src/lib/backup/golden/v1-1.ask214backup', import.meta.url);

/** What the page does with the real worker: derive the AES key, then try to decrypt. The key never leaves the page. */
type OpenArgs = {
	src: string;
	password: string;
	salt: number[];
	iv: number[];
	aad: number[];
	ct: number[];
};
type Opened =
	| { ok: true; plain: number[]; deriveMs: number }
	| { ok: false; step: 'worker' | 'decrypt'; code: string };

async function openInPage(page: Page, args: OpenArgs): Promise<Opened> {
	await page.goto('/');
	return page.evaluate(async (a): Promise<Opened> => {
		const worker = new Worker(a.src, { type: 'module' });
		const started = performance.now();
		const answer = await new Promise<{ key: CryptoKey } | { code: string }>((resolve) => {
			worker.onmessage = (
				event: MessageEvent<{ type: string; key?: CryptoKey; code?: string }>
			) => {
				const data = event.data;
				if (data.type === 'key' && data.key) resolve({ key: data.key });
				else if (data.type === 'error') resolve({ code: data.code ?? 'NO_CODE' });
			};
			worker.onerror = () => resolve({ code: 'WORKER_ERROR' });
			const pass = new TextEncoder().encode(a.password).buffer;
			worker.postMessage(
				{ op: 'derive', purpose: 'restore', pass, salt: Uint8Array.from(a.salt) },
				[pass]
			);
		});
		const deriveMs = performance.now() - started;
		worker.terminate();
		if (!('key' in answer)) return { ok: false, step: 'worker', code: answer.code };
		try {
			const plain = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: Uint8Array.from(a.iv),
					additionalData: Uint8Array.from(a.aad),
					tagLength: 128
				},
				answer.key,
				Uint8Array.from(a.ct)
			);
			return { ok: true, plain: Array.from(new Uint8Array(plain)), deriveMs };
		} catch (e) {
			return { ok: false, step: 'decrypt', code: e instanceof Error ? e.name : 'NOT_AN_ERROR' };
		}
	}, args);
}

/** The derive time per engine, as an annotation only: a runner's speed is not a fact about the code. */
function recordDeriveTime(browserName: string, deriveMs: number): void {
	const label = browserName === 'webkit' ? ' (WebKit: a proxy for Safari)' : '';
	test.info().annotations.push({
		type: 'derive-time',
		description: `${browserName}: ${Math.round(deriveMs)} ms${label}`
	});
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

test('the worker matches an independent Argon2id at the production tuple', async ({
	page,
	browserName
}) => {
	// The key the shipped worker must reach, built here from the independent Argon2id output with the same HKDF
	// step the app uses, then used to seal a fixed message with a fixed nonce and AAD.
	const material = await crypto.subtle.importKey('raw', hexToBytes(KAT_ARGON2_HEX), 'HKDF', false, [
		'deriveKey'
	]);
	const key = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: KAT_SALT, info: new TextEncoder().encode(HKDF_INFO_V1) },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt']
	);
	const iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
	const aad = new TextEncoder().encode('kat-aad');
	const message = 'the worker and the independent Argon2id reached the same key';
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
			key,
			new TextEncoder().encode(message)
		)
	);

	const opened = await openInPage(page, {
		src: KDF_WORKER_SRC,
		password: KAT_PASSWORD,
		salt: Array.from(KAT_SALT),
		iv: Array.from(iv),
		aad: Array.from(aad),
		ct: Array.from(ct)
	});

	// Compared as a whole object so a failure prints the step and the code it stopped at.
	expect(opened).toEqual(expect.objectContaining({ ok: true }));
	if (!opened.ok) return;
	recordDeriveTime(browserName, opened.deriveMs);
	expect(new TextDecoder().decode(Uint8Array.from(opened.plain))).toBe(message);
});

type PinProof =
	{ ok: true; macHex: string; wrapHex: string; deriveMs: number } | { ok: false; code: string };

/** What the page does with the real worker for the PIN step: derive the two keys, then prove each with a fixed input. */
async function pinProofInPage(
	page: Page,
	args: { src: string; pin: string; salt: number[]; message: string; toWrap: number[] }
): Promise<PinProof> {
	await page.goto('/');
	return page.evaluate(async (a): Promise<PinProof> => {
		const worker = new Worker(a.src, { type: 'module' });
		const started = performance.now();
		const answer = await new Promise<{ macKey: CryptoKey; kek: CryptoKey } | { code: string }>(
			(resolve) => {
				worker.onmessage = (
					event: MessageEvent<{ type: string; macKey?: CryptoKey; kek?: CryptoKey; code?: string }>
				) => {
					const data = event.data;
					if (data.type === 'pin-keys' && data.macKey && data.kek) {
						resolve({ macKey: data.macKey, kek: data.kek });
					} else if (data.type === 'error') resolve({ code: data.code ?? 'NO_CODE' });
				};
				worker.onerror = () => resolve({ code: 'WORKER_ERROR' });
				const pin = new TextEncoder().encode(a.pin).buffer;
				worker.postMessage({ op: 'derive-pin', pin, salt: Uint8Array.from(a.salt) }, [pin]);
			}
		);
		const deriveMs = performance.now() - started;
		worker.terminate();
		if (!('macKey' in answer)) return { ok: false, code: answer.code };
		const hex = (buffer: ArrayBuffer) =>
			Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
		const mac = await crypto.subtle.sign(
			'HMAC',
			answer.macKey,
			new TextEncoder().encode(a.message)
		);
		// Extractable only so the page can hand its bytes to the wrap; the keys under test stay non-extractable.
		const toWrap = await crypto.subtle.importKey(
			'raw',
			Uint8Array.from(a.toWrap),
			{ name: 'HMAC', hash: 'SHA-256' },
			true,
			['sign']
		);
		const wrapped = await crypto.subtle.wrapKey('raw', toWrap, answer.kek, 'AES-KW');
		return { ok: true, macHex: hex(mac), wrapHex: hex(wrapped), deriveMs };
	}, args);
}

test('the PIN step of the worker matches an independent computation at the production tuple', async ({
	page,
	browserName
}) => {
	const proof = await pinProofInPage(page, {
		src: KDF_WORKER_SRC,
		pin: KAT_PIN,
		salt: Array.from(KAT_SALT),
		message: KAT_PIN_MAC_MESSAGE,
		toWrap: Array.from(KAT_PIN_WRAPPED_KEY)
	});

	expect(proof).toEqual(expect.objectContaining({ ok: true }));
	if (!proof.ok) return;
	recordDeriveTime(browserName, proof.deriveMs);
	// Computed outside this repository's code: the MAC key and the wrapping key are what the independent HKDF gives.
	expect(proof.macHex).toBe(KAT_PIN_FULL.macHex);
	expect(proof.wrapHex).toBe(KAT_PIN_FULL.wrapHex);
});

test('the v1 golden opens through the real worker', async ({ page, browserName }) => {
	// The committed file goes through the app's own envelope reader, so its checks run on the real bytes.
	const text = readFileSync(GOLDEN_FILE, 'utf8');
	const read = await readBackupFile(new File([text], 'golden.ask214backup'));
	expect(read).toEqual(expect.objectContaining({ ok: true }));
	if (!read.ok) return;
	const { salt, iv, ct } = read.envelope;

	const opened = await openInPage(page, {
		src: KDF_WORKER_SRC,
		password: GOLDEN_PASSWORD,
		salt: Array.from(salt),
		iv: Array.from(iv),
		aad: Array.from(new TextEncoder().encode(buildBackupAad(salt, iv))),
		ct: Array.from(ct)
	});

	expect(opened).toEqual(expect.objectContaining({ ok: true }));
	if (!opened.ok) return;
	recordDeriveTime(browserName, opened.deriveMs);
	// The decrypt is the proof: the reader pinned the bytes and AES-GCM authenticates the plaintext, so what opens here is
	// exactly what golden.browser.test.ts validates and restores deep-equal.
});
