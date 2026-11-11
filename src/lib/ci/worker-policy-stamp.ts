import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { parseHeadersFile } from './headers-policy.ts';

const WORKERS_PATH = '/_app/immutable/workers/*';
const STAMP_HEX = 8;

/**
 * A short comment that names the workers folder's content security policy, for the top of each worker script.
 *
 * The workers are served under hashed names with a one-year immutable cache, and a browser keeps a cached script's
 * headers with it. A policy added or changed in `_headers` would then reach only devices that never fetched the
 * script. With the stamp in the script's own bytes, a policy change changes the hash, so the name changes and every
 * device fetches the script again, with its new policy.
 *
 * @param headersText The `_headers` file's text.
 * @returns The comment, `/*p:<8 hex>*\/`.
 */
export function policyStamp(headersText: string): string {
	const policy = parseHeadersFile(headersText).get(WORKERS_PATH)?.['Content-Security-Policy'];
	if (policy === undefined) throw new Error('E_WORKER_POLICY_MISSING');
	return `/*p:${createHash('sha256').update(policy).digest('hex').slice(0, STAMP_HEX)}*/`;
}

/**
 * Write the policy stamp at the top of every worker chunk.
 *
 * @param file The `_headers` file, read once when the plugin is made.
 * @returns A plugin for the worker bundle.
 */
export function workerPolicyStamp(file: string): Plugin {
	const stamp = policyStamp(readFileSync(file, 'utf8'));
	// After minification, which would strip a comment written before it.
	return {
		name: 'worker-policy-stamp',
		outputOptions: (options) => ({ ...options, postBanner: stamp })
	};
}
