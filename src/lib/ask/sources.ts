import type { Corpus } from '$lib/corpus';
import { cleanExcerpt } from '$lib/corpus';

/** One block the reader shows: the cited-id match target plus its divider metadata. */
export type SourcePassage = { id: string; text: string; page?: number; section?: string };

/** All the official text held on-device for one source - the unit the offline reader shows. */
export type Source = {
	sourceId: string;
	title: string;
	url: string;
	passages: SourcePassage[];
};

/**
 * Group a decoded corpus's chunks by source so the reader can show all the official text held on-device
 * for a given source, offline. Each chunk becomes a passage carrying its id (the reader highlights the
 * cited chunk by id) plus page/section (the reader's dividers). First-seen (corpus) order; a source's
 * chunks are the full document, so this yields the whole doc offline.
 */
export function sourcesFromCorpus(corpus: Corpus): Map<string, Source> {
	const sources = new Map<string, Source>();
	for (const chunk of corpus.chunks) {
		// Clean the residual extraction artifacts for display; the raw chunk.text stays the retrieval unit.
		const passage: SourcePassage = {
			id: chunk.id,
			text: cleanExcerpt(chunk.text),
			...(chunk.page !== undefined ? { page: chunk.page } : {}),
			...(chunk.section !== undefined ? { section: chunk.section } : {})
		};
		const existing = sources.get(chunk.sourceId);
		if (existing) {
			existing.passages.push(passage);
		} else {
			sources.set(chunk.sourceId, {
				sourceId: chunk.sourceId,
				title: chunk.sourceTitle,
				url: chunk.url,
				passages: [passage]
			});
		}
	}
	return sources;
}
