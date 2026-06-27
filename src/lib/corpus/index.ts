/** Public surface of the Corpus Retrieval Core. Consumed by the Ask feature (Transformers.js + Ask UI). */
export { decodeCorpus, ACCEPTED_CORPUS_VERSION } from './codec';
export { search, cosineSimilarity, normalize } from './search';
export { toResultCards } from './cards';
export { CorpusFormatError, CorpusVersionError } from './errors';
export type { CorpusChunk, CorpusManifest, Corpus, RetrievalResult, ResultCard } from './types';
