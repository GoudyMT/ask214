/**
 * Fail-closed bootstrap capability gate. Rather than feature-DETECTING APIs
 * (which can exist but be non-functional - e.g. IndexedDB blocked in some
 * private-browsing modes), this EXERCISES the four primitives the app cannot
 * run without. Any failure -> not ok; no polyfill, no fallback. The caller
 * renders the UnsupportedBrowser screen (known-good browser list) on a non-ok
 * result; `cause` feeds its muted technical-detail line.
 *
 * AES-GCM keygen implicitly covers secure-context + SubtleCrypto (crypto.subtle
 * is undefined outside a secure context). BroadcastChannel is intentionally NOT
 * gated: v1.0 multi-tab is best-effort, so its absence must not block core use.
 */
import { hmacSign, hmacVerify } from './hmac';

export type CapabilityCause = 'subtle-crypto' | 'indexed-db' | 'navigator-locks' | 'hmac';

export type CapabilityResult = { ok: true } | { ok: false; cause: CapabilityCause };

export type CapabilityOps = {
	subtleCrypto: () => Promise<void>;
	indexedDb: () => Promise<void>;
	navigatorLocks: () => Promise<void>;
	hmac: () => Promise<void>;
};

const PROBE_NAME = '__mtc_capability_probe__';
const LOCK_TIMEOUT_MS = 10000;

async function probeSubtleCrypto(): Promise<void> {
	await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function probeIndexedDb(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = indexedDB.open(PROBE_NAME);
		req.onerror = () => reject(req.error ?? new Error('idb-open-failed'));
		req.onsuccess = () => {
			req.result.close();
			indexedDB.deleteDatabase(PROBE_NAME);
			resolve();
		};
	});
}

async function probeNavigatorLocks(): Promise<void> {
	// Bounded wait per Phase 2 spec invariant 6 (no silent lock drops): a hung
	// locks API must fail the probe, not hang bootstrap.
	await navigator.locks.request(
		PROBE_NAME,
		{ signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
		async () => {
			// Acquiring + releasing a uniquely-named lock proves the API works.
		}
	);
}

async function probeHmac(): Promise<void> {
	const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
	const data = new TextEncoder().encode('mtc-capability-probe');
	const sig = await hmacSign(key, data);
	if (!(await hmacVerify(key, data, sig))) throw new Error('hmac-roundtrip-failed');
}

export const realCapabilityOps: CapabilityOps = {
	subtleCrypto: probeSubtleCrypto,
	indexedDb: probeIndexedDb,
	navigatorLocks: probeNavigatorLocks,
	hmac: probeHmac
};

/**
 * Sequentially exercises each capability and returns the FIRST failure's cause
 * (deterministic order), or `{ ok: true }` if all pass. `ops` is injectable for
 * testing failure paths; production passes the real probes.
 */
export async function checkBrowserSupport(
	ops: CapabilityOps = realCapabilityOps
): Promise<CapabilityResult> {
	const steps: ReadonlyArray<readonly [CapabilityCause, () => Promise<void>]> = [
		['subtle-crypto', ops.subtleCrypto],
		['indexed-db', ops.indexedDb],
		['navigator-locks', ops.navigatorLocks],
		['hmac', ops.hmac]
	];
	for (const [cause, run] of steps) {
		try {
			await run();
		} catch {
			return { ok: false, cause };
		}
	}
	return { ok: true };
}
