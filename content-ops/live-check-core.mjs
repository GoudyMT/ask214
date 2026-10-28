/**
 * The decisions behind the live check: whether the live site runs the merged build, and whether its online
 * answers come from the answer library the app expects. Pure functions; the runner does the network calls.
 */

// The constant's line in src/lib/corpus/codec.ts, e.g. export const ACCEPTED_CORPUS_VERSION = '1.0.2';
const ACCEPTED_LINE = /ACCEPTED_CORPUS_VERSION\s*=\s*'([^']+)'/;

/**
 * Whether the live build is from after the merge.
 *
 * SvelteKit stamps each build's `_app/version.json` with the build time in milliseconds, and the host builds
 * after the push, so a build time at or after the merge commit's time means the merge is what is live.
 *
 * @param {string} versionJsonText The body of the live `/_app/version.json`.
 * @param {number} mergedAtMs The merge commit's time, in milliseconds.
 * @returns {boolean} True once the live build is from after the merge.
 * @throws {Error} `E_LIVE_BAD_VERSION` when the body is not a build stamp.
 */
export function deployLanded(versionJsonText, mergedAtMs) {
	let version;
	try {
		version = JSON.parse(versionJsonText)?.version;
	} catch {
		throw new Error('E_LIVE_BAD_VERSION');
	}
	if (typeof version !== 'string' || !/^\d+$/.test(version)) throw new Error('E_LIVE_BAD_VERSION');
	return Number(version) >= mergedAtMs;
}

/**
 * Throws unless the live retrieve answer is healthy and from the expected answer library.
 *
 * @param {{ httpStatus: number, body: unknown }} response The live answer to the public question.
 * @param {string} acceptedVersion The answer-library version the app accepts.
 * @throws {Error} `E_LIVE_HTTP` (not a 200), `E_LIVE_NO_RESULTS` (no results returned) or
 *   `E_LIVE_VERSION_MISMATCH` (results from another library version).
 */
export function judgeAnswer(response, acceptedVersion) {
	if (response.httpStatus !== 200) throw new Error('E_LIVE_HTTP');
	const body = /** @type {{ status?: unknown, corpusVersion?: unknown } | null} */ (response.body);
	if (body?.status !== 'results') throw new Error('E_LIVE_NO_RESULTS');
	if (body.corpusVersion !== acceptedVersion) throw new Error('E_LIVE_VERSION_MISMATCH');
}

/**
 * Whether a failed question is worth one more try. A network blip, a refused request or a busy moment can clear
 * on its own; an answer from the wrong library is the outage itself and never clears by asking again.
 *
 * @param {string} code The static error code the question failed with.
 * @returns {boolean} True when one retry may clear it.
 */
export function worthRetrying(code) {
	return code !== 'E_LIVE_VERSION_MISMATCH';
}

/**
 * The answer-library version the app accepts, read from the codec's source.
 *
 * @param {string} codecSource The text of src/lib/corpus/codec.ts.
 * @returns {string} The accepted version.
 * @throws {Error} `E_LIVE_NO_ACCEPTED_VERSION` when the constant is not found.
 */
export function readAcceptedVersion(codecSource) {
	const version = ACCEPTED_LINE.exec(codecSource)?.[1];
	if (version === undefined) throw new Error('E_LIVE_NO_ACCEPTED_VERSION');
	return version;
}
