import type { Corpus, ResultCard } from '$lib/corpus';
import { cleanExcerpt } from '$lib/corpus';
import { stripHeadingEcho } from './answer/heading-echo';

/**
 * One block the reader shows: the cited-id match target, its divider metadata, and the stored anchor - the
 * raw extracted text the page view searches for in the document, which the cleaned `text` no longer is.
 */
export type SourcePassage = {
	id: string;
	text: string;
	page?: number;
	section?: string;
	anchor?: string;
};

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
		// The duplicated heading goes so the section divider does not stutter with the block's first words.
		const text = stripHeadingEcho(cleanExcerpt(chunk.text), chunk.section);
		const passage: SourcePassage = {
			id: chunk.id,
			text,
			...(chunk.page !== undefined ? { page: chunk.page } : {}),
			...(chunk.section !== undefined ? { section: chunk.section } : {}),
			...(chunk.anchor?.exact !== undefined ? { anchor: chunk.anchor.exact } : {})
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

/**
 * The reader's source for an ONLINE answer, built from the card the user opened: that one passage, shown as
 * the on-device reader shows it and anchored on the text as retrieved. An online answer already carries its
 * passage, so its source opens without the answer library, which is several megabytes and exists for
 * answering offline.
 */
export function sourceFromCard(card: ResultCard): Source {
	const passage: SourcePassage = {
		id: card.chunkId ?? '',
		// The card's excerpt is already cleaned; the heading echo goes here, as the corpus path drops it.
		text: stripHeadingEcho(card.excerpt, card.section),
		...(card.page !== undefined ? { page: card.page } : {}),
		...(card.section !== undefined ? { section: card.section } : {}),
		...(card.anchor !== undefined ? { anchor: card.anchor } : {})
	};
	return { sourceId: card.sourceId, title: card.sourceTitle, url: card.url, passages: [passage] };
}
