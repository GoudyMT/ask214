// TEST-ONLY fixtures for the synthesis path. Not imported by any app module and not re-exported from a
// barrel.
//
// Why this exists. The BYO-key synthesis feature shipped and never once produced an answer: chunk ids are
// `<sourceId>:<12 hex>` and the citation parser's character class had no colon, so no real id could match
// and every request refused. It survived review because EVERY id fixture on this path was a short,
// colon-free, digit-free slug ('tap_moc_crosswalk', 'a', 'va'), and a slug parses fine. The sweep that
// found it counted seven test files sharing that blind spot, and four more defects that a realistic
// fixture would have exposed at the same time.
//
// So the ids here are DERIVED, never written down. `deriveChunkId` is the shipped identity rule, so these
// carry the real shape - including the digits that made the marker look like a numeric claim to the
// grounding gate - and they cannot drift the way a hard-coded literal would when the corpus is re-cleaned.
import { deriveChunkId } from '$lib/corpus/chunk-id';
import type { RetrievedChunk } from './synthesize';

// Real prose from the shipped corpus, chosen so the fixture exercises what the unrealistic ones hid:
// a multi-paragraph answer, a figure the model can legitimately quote, and a second source so a
// cross-chunk citation can be tested.
const SKILLBRIDGE_TEXT =
	'SkillBridge lets you train with a civilian employer during your last 180 days of service. ' +
	'Participation requires unit commander approval.';
const EFCT_TEXT =
	'The Employment Fundamentals of Career Transition workshop runs for 1 day. ' +
	'It introduces the tools used in a civilian job search.';

/**
 * Build the synthesis fixture chunks with real, derived chunk ids.
 *
 * Returns:
 *     Two retrieved chunks whose ids carry the shipped `<sourceId>:<12 hex>` shape.
 */
export async function realChunks(): Promise<RetrievedChunk[]> {
	return [
		{
			id: await deriveChunkId('dod_skillbridge', SKILLBRIDGE_TEXT),
			text: SKILLBRIDGE_TEXT,
			url: 'https://skillbridge.osd.mil/',
			title: 'DoD SkillBridge'
		},
		{
			id: await deriveChunkId('tap_dol_efct', EFCT_TEXT),
			text: EFCT_TEXT,
			url: 'https://www.dol.gov/agencies/vets/programs/tap',
			title: 'Employment Fundamentals of Career Transition'
		}
	];
}

/**
 * The collision-suffixed id form. The chunk-assignment step appends `-<n>` to disambiguate an
 * intra-source exact duplicate, so 8 ids in the shipped corpus carry it and any id pattern must accept it.
 *
 * Args:
 *     sourceId: The source the duplicate belongs to.
 *     text: The chunk text the base id is derived from.
 *     n: The disambiguation ordinal.
 *
 * Returns:
 *     The suffixed chunk id.
 */
export async function collisionId(sourceId: string, text: string, n: number): Promise<string> {
	return `${await deriveChunkId(sourceId, text)}-${n}`;
}
