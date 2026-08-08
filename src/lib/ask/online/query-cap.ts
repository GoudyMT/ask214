// A hard length cap BEFORE the embed so a max-length query cannot inflate neuron spend. Char-based -- a
// cheap proxy for the token budget, kept well under bge-small's ~512-token ceiling.
export function capQuery(query: string, maxChars: number): string {
	return query.trim().slice(0, maxChars);
}
