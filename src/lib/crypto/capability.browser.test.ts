import { describe, it, expect } from 'vitest';
import { checkBrowserSupport, realCapabilityOps, type CapabilityOps } from './capability';

const passingOps: CapabilityOps = {
	subtleCrypto: async () => {},
	indexedDb: async () => {},
	navigatorLocks: async () => {},
	hmac: async () => {}
};

const fail = async (): Promise<void> => {
	throw new Error('probe-failed');
};

describe('checkBrowserSupport', () => {
	it('returns ok against the real environment (Chromium)', async () => {
		const r = await checkBrowserSupport(realCapabilityOps);
		expect(r).toEqual({ ok: true });
	});

	it('returns ok when all injected probes pass', async () => {
		const r = await checkBrowserSupport(passingOps);
		expect(r).toEqual({ ok: true });
	});

	it('fails closed with cause=subtle-crypto', async () => {
		const r = await checkBrowserSupport({ ...passingOps, subtleCrypto: fail });
		expect(r).toEqual({ ok: false, cause: 'subtle-crypto' });
	});

	it('fails closed with cause=indexed-db', async () => {
		const r = await checkBrowserSupport({ ...passingOps, indexedDb: fail });
		expect(r).toEqual({ ok: false, cause: 'indexed-db' });
	});

	it('fails closed with cause=navigator-locks', async () => {
		const r = await checkBrowserSupport({ ...passingOps, navigatorLocks: fail });
		expect(r).toEqual({ ok: false, cause: 'navigator-locks' });
	});

	it('fails closed with cause=hmac', async () => {
		const r = await checkBrowserSupport({ ...passingOps, hmac: fail });
		expect(r).toEqual({ ok: false, cause: 'hmac' });
	});

	it('reports the FIRST failing probe (deterministic order)', async () => {
		const r = await checkBrowserSupport({ ...passingOps, subtleCrypto: fail, indexedDb: fail });
		expect(r).toEqual({ ok: false, cause: 'subtle-crypto' });
	});
});
