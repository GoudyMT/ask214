import { decryptCalendarRecord, encryptCalendarRecord } from '../calendar/crypto-boundary';
import type { CalendarSyncState } from '../calendar/types';
import { decryptRecord, encryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { rotateOrUpgrade } from '../db/locks';
import { ENCRYPTED_STORES, type EncryptedStoreName } from '../db/registry';
import { reqToPromise, withStores, type StoreName } from '../db/schema';
import { decryptProfileRecord, encryptProfileRecord } from '../profile/crypto-boundary';
import { zeroizeRecord } from '../profile/lifecycle';
import {
	signSidecar,
	verifySidecar,
	type ProfileHwmPayload,
	type SignedSidecar
} from '../profile/sidecars';
import type { ProfileV1 } from '../profile/types';
import {
	decryptFinderRecord,
	encryptFinderRecord
} from '../skillbridge-finder/state/crypto-boundary';
import type { FinderRecord } from '../skillbridge-finder/state/types';
import { decryptTimelineRecord, encryptTimelineRecord } from '../timeline/crypto-boundary';
import type { TimelineState } from '../timeline/types';
import { bumpCounterIn, clearTriesIn } from './app-lock-store';
import { readKeystoreRow } from './read';
import {
	keyIdentity,
	PIN_BAG_BYTES,
	signKeystore,
	type KdfTuple,
	type KeyIdentity,
	type KeystoreKeys,
	type KeystoreRecordPin
} from './record';
import { openPinSession, withOwnKeyChange, type KeySession } from './session';

/** A store that held a record this run could not verify or open; nothing was written. The detail stays out of the code. */
export class RotationStoreError extends Error {
	readonly store: StoreName;
	constructor(store: StoreName) {
		super('E_ROTATE_UNREADABLE');
		this.name = 'RotationStoreError';
		this.store = store;
	}
}

export type RotationResult = { session: KeySession; packHadFiles: boolean };

type PinInput = {
	macKey: CryptoKey;
	kek: CryptoKey;
	salt: Uint8Array;
	kdf: KdfTuple;
	counterBefore: number;
};

type Deps = { afterPut?: (index: number, store: StoreName) => void };

type SidecarStore = 'profile' | 'timeline-state' | 'calendar-sync' | 'skillbridge-finder';
type MarkStore = `${SidecarStore}-hwm`;
type Body = { id: number; rec: Uint8Array };
type Mark = SignedSidecar<ProfileHwmPayload> & { id: number };
type Put = { store: StoreName; value: unknown };

// Wrapped keys are 32 bytes plus AES-KW's 8; the bag holds the data key, then the HMAC key.
const WRAPPED_KEY_BYTES = 40;
// What the move does with each encrypted store. Every registry entry must be named, so a store added to the registry
// fails the type-check here instead of being left behind under a key that is gone. A carried store is read out and
// sealed again by the code below; a cleared one holds public, re-downloadable rows and is emptied.
const FATE: Record<EncryptedStoreName, 'carried' | 'cleared'> = {
	profile: 'carried',
	'timeline-state': 'carried',
	'calendar-sync': 'carried',
	byok: 'carried',
	'skillbridge-finder': 'carried',
	'skillbridge-finder-pack': 'cleared'
};
const CLEARED: StoreName[] = ENCRYPTED_STORES.filter((store) => FATE[store] === 'cleared');
// The stored API key has no marker: one fixed generation and the context its store seals it under.
const BYOK_CTX: RecordCtx = { storeName: 'byok', recordId: 'self', schemaVersion: 1 };
const BYOK_GENERATION = 1;

/** What one store needs to be read out and sealed again: its boundary's two calls. */
type Codec<T> = {
	open: (
		blob: Uint8Array,
		identity: KeyIdentity,
		dataKey: CryptoKey,
		generation: number
	) => Promise<T>;
	seal: (
		value: T,
		identity: KeyIdentity,
		dataKey: CryptoKey,
		generation: number
	) => Promise<Uint8Array>;
};

const PROFILE: Codec<ProfileV1> = {
	open: decryptProfileRecord,
	// The profile carries its own generation inside the record.
	seal: (value, identity, dataKey) => encryptProfileRecord(value, identity, dataKey)
};
const TIMELINE: Codec<TimelineState> = {
	open: decryptTimelineRecord,
	seal: encryptTimelineRecord
};
const CALENDAR: Codec<CalendarSyncState> = {
	open: decryptCalendarRecord,
	seal: encryptCalendarRecord
};
const FINDER: Codec<FinderRecord> = {
	open: decryptFinderRecord,
	seal: encryptFinderRecord
};

/** A record read out under the old keys, with what it takes to seal it under the new ones. */
type Carried = {
	store: SidecarStore;
	mark: MarkStore;
	payload: ProfileHwmPayload;
	/** Null for a marker at generation 0: no record has been saved yet, so only the marker moves. */
	seal: ((identity: KeyIdentity, dataKey: CryptoKey) => Promise<Uint8Array>) | null;
};

/**
 * Reads one store through its own boundary under the current keys, the way the store's load does: the marker first, then
 * the record at the marker's generation. A store with neither is skipped (or refused when `required`); anything that
 * does not verify or open is the store's error and nothing else.
 */
async function carry<T>(
	spec: {
		store: SidecarStore;
		required: boolean;
		codec: Codec<T>;
		/** For a record that carries its own generation: it is sealed at that number, so it must be the marker's. */
		ownGeneration?: (value: T) => number;
	},
	body: Body | undefined,
	mark: Mark | undefined,
	identity: KeyIdentity,
	keys: KeystoreKeys,
	opened?: (value: T) => void
): Promise<Carried | null> {
	const markStore: MarkStore = `${spec.store}-hwm`;
	try {
		if (!mark) {
			if (body || spec.required) throw new RotationStoreError(spec.store);
			return null;
		}
		const payload = await verifySidecar<ProfileHwmPayload>(
			markStore,
			{ v: 1, payload: mark.payload, mac: mark.mac },
			keys.hmacKey
		);
		if (payload.generation === 0) {
			// A record behind a marker that says nothing was saved is damage, never a first visit.
			if (body) throw new RotationStoreError(spec.store);
			return { store: spec.store, mark: markStore, payload, seal: null };
		}
		if (!body) throw new RotationStoreError(spec.store);
		const value = await spec.codec.open(body.rec, identity, keys.dataKey, payload.generation);
		opened?.(value);
		// Sealed at one number and opened at another, a record would never open again, and this move drops the old key.
		if (spec.ownGeneration && spec.ownGeneration(value) !== payload.generation) {
			throw new RotationStoreError(spec.store);
		}
		return {
			store: spec.store,
			mark: markStore,
			payload,
			seal: (id, key) => spec.codec.seal(value, id, key, payload.generation)
		};
	} catch {
		throw new RotationStoreError(spec.store);
	}
}

/**
 * Every row the move reads, in ONE readonly transaction so they are a cut taken at one moment. The exclusive keystore
 * lock already keeps the app's own writers out; this keeps the rows from pairing a record of one moment with a marker of
 * another.
 */
function readCut(db: IDBDatabase) {
	const stores: StoreName[] = [
		'profile',
		'profile-hwm',
		'timeline-state',
		'timeline-state-hwm',
		'calendar-sync',
		'calendar-sync-hwm',
		'skillbridge-finder',
		'skillbridge-finder-hwm',
		'byok',
		...CLEARED
	];
	return withStores(db, stores, 'readonly', (tx) => {
		const get = <T>(store: StoreName) => reqToPromise<T | undefined>(tx.objectStore(store).get(0));
		return Promise.all([
			get<Body>('profile'),
			get<Mark>('profile-hwm'),
			get<Body>('timeline-state'),
			get<Mark>('timeline-state-hwm'),
			get<Body>('calendar-sync'),
			get<Mark>('calendar-sync-hwm'),
			get<Body>('skillbridge-finder'),
			get<Mark>('skillbridge-finder-hwm'),
			get<Body>('byok'),
			Promise.all(CLEARED.map((store) => reqToPromise<number>(tx.objectStore(store).count()))).then(
				(counts) => counts.reduce((sum, count) => sum + count, 0)
			)
		]);
	});
}

/**
 * ONE readwrite transaction with strict durability, so the writes reach disk before it reports done. Resolves after the
 * commit. A throw from `fn` (or from any request) aborts it, and an aborted transaction leaves every store as it was.
 */
function commit(
	db: IDBDatabase,
	stores: StoreName[],
	fn: (tx: IDBTransaction) => Promise<void>
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('E_ROTATE_WRITE'));
		tx.onabort = () => reject(tx.error ?? new Error('E_ROTATE_WRITE'));
		fn(tx).catch((err: unknown) => {
			try {
				tx.abort();
			} catch {
				// The transaction is already finished or aborting.
			}
			reject(err);
		});
	});
}

/**
 * Under the exclusive keystore lock, moves every encrypted record onto new keys wrapped under the PIN's key and writes a
 * PIN-mode keystore row, all in ONE readwrite transaction. Returns the new session for the caller to set; it does not
 * set it. Turn-on calls it on a local row; a later PIN change calls it on a PIN row with a live session.
 *
 * Either every store is on the new keys or none is: the records, their markers, the key row, the lock counter and the
 * cleared wrong tries are one commit. Each record keeps its own generation, so a backup's mark stays true. The finder's
 * downloaded files are public and are dropped, not moved.
 */
export async function rotateToPin(
	db: IDBDatabase,
	pin: PinInput,
	deps: Deps = {}
): Promise<RotationResult> {
	// Every plaintext this run holds as bytes, wiped on every way out. The boundaries wipe their own buffers; these are
	// the ones read out and held across the awaits. The API key is never turned into a string here, so no text copy of
	// it exists in this run.
	const staged: Uint8Array[] = [];
	const records: ProfileV1[] = [];

	// The one place a key is made extractable, and only until it is wrapped under the PIN's key: the wrapped bytes are
	// all that leaves this function. The working keys are unwrapped from the bag, non-extractable.
	const makeBag = async (): Promise<Uint8Array> => {
		const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt'
		]);
		const hmacKey = await crypto.subtle.generateKey(
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			true,
			['sign', 'verify']
		);
		const bag = new Uint8Array(PIN_BAG_BYTES);
		bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, pin.kek, 'AES-KW')), 0);
		bag.set(
			new Uint8Array(await crypto.subtle.wrapKey('raw', hmacKey, pin.kek, 'AES-KW')),
			WRAPPED_KEY_BYTES
		);
		return bag;
	};

	try {
		// The own-change flag covers only the time the lock is held: it is exempt from relocking this tab, so it must not
		// outlast the change.
		return await rotateOrUpgrade(() =>
			withOwnKeyChange(() => move(db, pin, deps, makeBag, staged, records))
		);
	} finally {
		for (const bytes of staged) bytes.fill(0);
		for (const record of records) zeroizeRecord(record as unknown as Record<string, unknown>);
	}
}

async function move(
	db: IDBDatabase,
	pin: PinInput,
	deps: Deps,
	makeBag: () => Promise<Uint8Array>,
	staged: Uint8Array[],
	records: ProfileV1[]
): Promise<RotationResult> {
	// 1. Read out every record under the current keys, before anything is written. A local row gives its own key
	// handles; a PIN row gives the live session's.
	const { row, keys } = await readKeystoreRow(db);
	const identity = keyIdentity(row);
	const [
		profileBody,
		profileMark,
		timelineBody,
		timelineMark,
		calendarBody,
		calendarMark,
		finderBody,
		finderMark,
		byokBody,
		packRows
	] = await readCut(db);
	const carried: Carried[] = [];
	const add = (item: Carried | null) => {
		if (item) carried.push(item);
	};
	add(
		await carry(
			{
				store: 'profile',
				required: true,
				codec: PROFILE,
				ownGeneration: (profile) => profile.generation
			},
			profileBody,
			profileMark,
			identity,
			keys,
			(profile) => records.push(profile)
		)
	);
	add(
		await carry(
			{ store: 'timeline-state', required: false, codec: TIMELINE },
			timelineBody,
			timelineMark,
			identity,
			keys
		)
	);
	add(
		await carry(
			{ store: 'calendar-sync', required: false, codec: CALENDAR },
			calendarBody,
			calendarMark,
			identity,
			keys
		)
	);
	add(
		await carry(
			{ store: 'skillbridge-finder', required: false, codec: FINDER },
			finderBody,
			finderMark,
			identity,
			keys
		)
	);
	let apiKey: Uint8Array | null = null;
	if (byokBody) {
		try {
			apiKey = await decryptRecord(BYOK_CTX, byokBody.rec, identity, keys.dataKey, BYOK_GENERATION);
		} catch {
			throw new RotationStoreError('byok');
		}
		staged.push(apiKey);
	}

	// 2. The new row and the keys it holds. The row is opened the way an unlock opens it, so a bag or a PIN key that
	// would not open fails here, before the write, and the working keys are the non-extractable ones.
	const bag = await makeBag();
	const next: KeystoreRecordPin & { id: number } = {
		id: 0,
		v: 1,
		mode: 'pin',
		keystoreGeneration: row.keystoreGeneration + 1,
		epoch: row.epoch + 1,
		ivCounter: 0,
		installUuid: new Uint8Array(row.installUuid),
		kdf: { ...pin.kdf },
		salt: new Uint8Array(pin.salt),
		bag
	};
	next.recordHmac = await signKeystore(next, { bootstrapMacKey: pin.macKey });
	// The counter is the one the commit below will write: it checks it against what it finds.
	const session = await openPinSession(
		next,
		{ macKey: pin.macKey, kek: pin.kek },
		pin.counterBefore + 1
	);

	// 3. Seal everything under the new keys, each record at its own generation, and sign the markers again.
	const newIdentity = keyIdentity(next);
	const puts: Put[] = [];
	for (const item of carried) {
		if (item.seal) {
			puts.push({
				store: item.store,
				value: { id: 0, rec: await item.seal(newIdentity, session.dataKey) }
			});
		}
		const signed = await signSidecar(
			item.mark,
			{ ...item.payload, keystoreGeneration: next.keystoreGeneration, epoch: next.epoch },
			session.hmacKey
		);
		puts.push({ store: item.mark, value: { id: 0, ...signed } });
	}
	if (apiKey) {
		const rec = await encryptRecord(
			BYOK_CTX,
			apiKey,
			newIdentity,
			session.dataKey,
			BYOK_GENERATION
		);
		puts.push({ store: 'byok', value: { id: 0, rec } });
	}
	puts.push({ store: 'keystore', value: next });

	// 4. One transaction. The counter goes first: if it is not the one the caller noted, the lock moved while the PIN was
	// being made (an erase, a restore or another tab's change), and the whole move is dropped.
	const touched = new Set<StoreName>([...puts.map((put) => put.store), ...CLEARED, 'app-lock']);
	await commit(db, [...touched], async (tx) => {
		let written = 0;
		const counter = await bumpCounterIn(tx);
		if (counter !== pin.counterBefore + 1) throw new Error('E_ROTATE_MOVED');
		deps.afterPut?.(written++, 'app-lock');
		for (const put of puts) {
			tx.objectStore(put.store).put(put.value);
			deps.afterPut?.(written++, put.store);
		}
		for (const store of CLEARED) tx.objectStore(store).clear();
		clearTriesIn(tx);
	});

	return { session, packHadFiles: packRows > 0 };
}
