import { decodeCorpus, type Corpus, type CorpusManifest } from '$lib/corpus';
import { EMBED_MODEL_ID } from './types';
import { AskError, ASK_ERROR } from './errors';

/**
 * Fetch the bundled corpus artifact (`<basePath>.json` + `<basePath>.embeddings.bin`) and decode it
 * via B into the in-memory `Corpus` (spec section 8). No IndexedDB / CDN in v1.0 - the artifact is a
 * same-origin static asset served (and service-worker-cached) by the app. `fetchFn` is injected for
 * testability. Any transport or decode failure -> AskError(E_ASK_CORPUS) (never leaks input).
 */
export async function loadCorpus(fetchFn: typeof fetch, basePath: string): Promise<Corpus> {
	try {
		const [mRes, bRes] = await Promise.all([
			fetchFn(`${basePath}.json`),
			fetchFn(`${basePath}.embeddings.bin`)
		]);
		if (!mRes.ok || !bRes.ok) throw new AskError(ASK_ERROR.CORPUS);
		const manifest = (await mRes.json()) as CorpusManifest;
		const buffer = await bRes.arrayBuffer();
		return decodeCorpus(manifest, buffer, EMBED_MODEL_ID); // B validates version/model/length/zero
	} catch (e) {
		if (e instanceof AskError) throw e;
		throw new AskError(ASK_ERROR.CORPUS); // wrap B's CorpusFormatError/Version + JSON errors opaquely
	}
}
