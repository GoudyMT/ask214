// Local build-only Worker (never deployed). Embeds a batch of texts through the Workers AI bge-small serving
// and returns the raw vectors, so the corpus index is built from the same model that serves the retrieve
// Worker at runtime. Ambient AI binding, zero secret. Run with `wrangler dev` (the AI binding is marked
// `remote: true` in wrangler.jsonc, so embeds hit the real serving while the worker runs in local dev);
// build-corpus-bge.mjs + eval-corpus-bge.mjs POST to it. The caller decides the prefix policy -- passages are
// sent verbatim, queries are sent WITH the bge instruction prefix -- so this Worker adds nothing to the text.
const MODEL = '@cf/baai/bge-small-en-v1.5';

export default {
	async fetch(request, env) {
		if (request.method !== 'POST') return new Response('POST only', { status: 405 });
		const body = await request.json();
		const texts = body?.texts;
		if (!Array.isArray(texts) || texts.length === 0) {
			return new Response(JSON.stringify({ error: 'E_NO_TEXTS' }), {
				status: 400,
				headers: { 'content-type': 'application/json' }
			});
		}
		const out = await env.AI.run(MODEL, { text: texts });
		return new Response(JSON.stringify({ vectors: out.data }), {
			headers: { 'content-type': 'application/json' }
		});
	}
};
