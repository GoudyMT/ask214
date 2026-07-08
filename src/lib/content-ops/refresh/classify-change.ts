export type ChangeStatus = 'changed' | 'unchanged' | 'manual-check-required';

export type SourceBaseline = {
	sourceId: string;
	contentHash: string;
	sourceUpdatedDate?: string;
};

export type FreshSignal = {
	hash?: string;
	updatedDate?: string;
	unfetchable?: boolean;
};

export type ChangeRecord = {
	sourceId: string;
	status: ChangeStatus;
	oldHash: string;
	newHash?: string;
	oldDate?: string;
	newDate?: string;
	reason: string;
};

// date = trigger signal, hash = change-confirm: a source is `changed` if its freshly-fetched
// content hash differs from the stored baseline, OR its own last-updated date is newer than the stored date.
export function classifyChange(baseline: SourceBaseline, fresh: FreshSignal): ChangeRecord {
	const { sourceId, contentHash: oldHash } = baseline;

	if (fresh.unfetchable === true) {
		return {
			sourceId,
			status: 'manual-check-required',
			oldHash,
			reason: 'source cannot be auto-fetched'
		};
	}

	const hashChanged = fresh.hash !== undefined && fresh.hash !== oldHash;
	const dateNewer =
		fresh.updatedDate !== undefined &&
		baseline.sourceUpdatedDate !== undefined &&
		fresh.updatedDate > baseline.sourceUpdatedDate;

	const status: ChangeStatus = hashChanged || dateNewer ? 'changed' : 'unchanged';
	const reason = hashChanged
		? 'content hash differs'
		: dateNewer
			? 'source date is newer'
			: 'no change detected';

	const record: ChangeRecord = { sourceId, status, oldHash, reason };
	if (fresh.hash !== undefined) record.newHash = fresh.hash;
	if (baseline.sourceUpdatedDate !== undefined) record.oldDate = baseline.sourceUpdatedDate;
	if (fresh.updatedDate !== undefined) record.newDate = fresh.updatedDate;
	return record;
}
