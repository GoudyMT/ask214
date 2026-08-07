import type { Corpus } from '$lib/corpus';
import { cleanExcerpt } from '$lib/corpus';

/** All the official text held on-device for one source - the unit the offline reader shows. */
export type Source = {
	sourceId: string;
	title: string;
	url: string;
	texts: string[];
};

/**
 * Group a decoded corpus's chunks by source so the UI can show all the official text held on-device for
 * a given source, offline (the "reference library" reader). The corpus IS the local database - each
 * chunk already carries its source title, url, and text; this just indexes them by source, in first-seen
 * order. (At cycle A a source's chunks are the full document, so this then yields the whole doc offline.)
 */
export function sourcesFromCorpus(corpus: Corpus): Map<string, Source> {
	const sources = new Map<string, Source>();
	for (const chunk of corpus.chunks) {
		// Clean the residual extraction artifacts for display; the raw chunk.text stays the retrieval unit.
		const passage = cleanExcerpt(chunk.text);
		const existing = sources.get(chunk.sourceId);
		if (existing) {
			existing.texts.push(passage);
		} else {
			sources.set(chunk.sourceId, {
				sourceId: chunk.sourceId,
				title: chunk.sourceTitle,
				url: chunk.url,
				texts: [passage]
			});
		}
	}
	return sources;
}
