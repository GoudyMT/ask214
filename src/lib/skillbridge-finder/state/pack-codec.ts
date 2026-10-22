import { isIsoDate } from '../contract/places';

/**
 * The one row of the finder's data pack that is the person's own: which listings they have opened, and the newest pull
 * they had seen when they last left. Its names carry the `finder` prefix for the same reason the finder record's do
 * (src/lib/skillbridge-finder/state/types.ts). The file rows hold the contract JSON as published and are checked by the
 * contract validators, not here.
 */
export const MAX_SEEN = 50_000;

export type FinderSeenRow = { finderSeen: number[]; finderLastSeenPull?: string };

/** Every refusal is a static code, so a row that cannot be read says so without echoing anything from it. */
export class FinderPackError extends Error {
	constructor(code: string) {
		super(code);
	}
}

function checkSeen(row: unknown): FinderSeenRow {
	if (typeof row !== 'object' || row === null || Array.isArray(row)) {
		throw new FinderPackError('E_FINDER_PACK_BAD_SEEN');
	}
	const { finderSeen, finderLastSeenPull } = row as Record<string, unknown>;
	if (
		!Array.isArray(finderSeen) ||
		finderSeen.length > MAX_SEEN ||
		!finderSeen.every((id) => Number.isSafeInteger(id) && (id as number) > 0) ||
		new Set(finderSeen).size !== finderSeen.length
	) {
		throw new FinderPackError('E_FINDER_PACK_BAD_SEEN');
	}
	if (finderLastSeenPull === undefined) return { finderSeen: finderSeen as number[] };
	if (!isIsoDate(finderLastSeenPull)) throw new FinderPackError('E_FINDER_PACK_BAD_SEEN');
	return { finderSeen: finderSeen as number[], finderLastSeenPull };
}

/** Encoding holds the line decoding does: a row written that cannot be read back would lose the person's marks. */
export function encodeSeen(row: FinderSeenRow): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(checkSeen(row)));
}

/** Reads the two fields it knows; a key a newer release added is ignored. */
export function decodeSeen(bytes: Uint8Array): FinderSeenRow {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new FinderPackError('E_FINDER_PACK_BAD_SEEN');
	}
	return checkSeen(parsed);
}
