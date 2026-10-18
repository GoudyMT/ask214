import { KDF_V1 } from './kdf-params';

/** The four base64 strings that vary between backups; everything else in the envelope is fixed by format v1. */
export type EnvelopeFields = { salt: string; iv: string; check: string; data: string };

/**
 * The backup file text: one JSON object with its keys in a fixed order and no spaces, so the same fields always give
 * the same bytes. It imports nothing from `caps.ts`, because `caps.ts` measures this text to size its file limit.
 */
export function serializeEnvelope({ salt, iv, check, data }: EnvelopeFields): string {
	return JSON.stringify({
		format: 'ask214-backup',
		version: 1,
		kdf: { alg: 'argon2id', v: KDF_V1.v, m: KDF_V1.m, t: KDF_V1.t, p: KDF_V1.p, salt },
		cipher: { alg: 'AES-GCM', iv },
		check,
		data
	});
}
