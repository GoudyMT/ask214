<script module lang="ts">
	import {
		createWaitClock,
		readTries,
		runPinCheck,
		type PinCheckResult,
		type TriesState
	} from '../keystore/app-lock-store';
	import { derivePinKeys, isPinFormat, PinNoMemoryError } from '../keystore/pin-derive';
	import { KeystoreHmacMismatchError, type KeystoreRow } from '../keystore/read';
	import type { KdfTuple } from '../keystore/record';
	import {
		dropSession,
		getSession,
		openPinSession,
		setSession,
		WrongPinError,
		type KeySession
	} from '../keystore/session';
	import { readPinRowAndCounter } from '../keystore/unlock-row';
	import { safeLog } from '../log/safelog';
	import { checkStoredBytes, readStoredBytes, sameStored } from '../profile/damaged-bytes';

	/** What a test stands in for: the derive (Argon2id lives in a worker), the row read, the wait clock and the reload. */
	export type PinUnlockDeps = {
		derive?: (
			pin: string,
			params: { kdf: KdfTuple; salt: Uint8Array }
		) => Promise<{ macKey: CryptoKey; kek: CryptoKey }>;
		readRow?: typeof readPinRowAndCounter;
		clock?: Parameters<typeof createWaitClock>[2];
		reload?: () => void;
	};

	const MS_PER_SECOND = 1_000;
	const SECONDS_PER_MINUTE = 60;

	/** A wait as a person reads it: whole seconds under a minute, else whole minutes rounded up. */
	export function formatWait(ms: number): string {
		const seconds = Math.ceil(ms / MS_PER_SECOND);
		if (seconds < SECONDS_PER_MINUTE) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
		const minutes = Math.ceil(seconds / SECONDS_PER_MINUTE);
		return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getProfileApp } from '../profile/context';
	import PinField from './PinField.svelte';

	type Props = {
		/** After the stores loaded; the page moves focus on, since this card is about to go. */
		onunlocked?: () => void;
		/** Set when focus is on its way here from a button that is about to go (Lock): the cursor goes to the field. */
		takeFocus?: boolean;
		deps?: PinUnlockDeps;
	};
	let { onunlocked, takeFocus = false, deps = {} }: Props = $props();

	const app = getProfileApp();

	// A wrong try and a try that was not 4-6 digits read the same on purpose: the card never says which it was.
	const NOT_RIGHT = 'That PIN is not right.';
	const LOW_MEMORY =
		'This phone ran out of memory while checking your PIN. Your PIN may be right. Close other apps and tabs, then try again.';
	const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
	const waitLine = (ms: number): string => `${NOT_RIGHT} You can try again in ${formatWait(ms)}.`;

	let value = $state('');
	let field = $state<ReturnType<typeof PinField> | null>(null);
	let busy = $state(false);
	let message = $state<string | null>(null);

	let clock: { remainingMs(): number; stop(): void } | null = null;
	let clockTimer: ReturnType<typeof setTimeout> | undefined;
	let waitText: string | null = null;
	let gone = false;

	function stopWait(): void {
		clock?.stop();
		clock = null;
		if (clockTimer !== undefined) clearTimeout(clockTimer);
		clockTimer = undefined;
	}

	// The line shows the wait owed when it was shown; it goes when that wait is over, and the clock writes the rest.
	function startWait(db: IDBDatabase, tries: TriesState): void {
		stopWait();
		if (gone || tries.waitMs <= 0) return;
		const counting = createWaitClock(db, tries, deps.clock);
		clock = counting;
		const check = (): void => {
			const left = counting.remainingMs();
			if (left > 0) {
				clockTimer = setTimeout(check, Math.ceil(left));
				return;
			}
			if (message === waitText) message = null;
		};
		clockTimer = setTimeout(check, Math.ceil(counting.remainingMs()));
	}

	// A new wait (a wrong try that owes one) starts its own count. A press that only finds the wait still owed leaves a
	// running count alone: restarting it from the last stored remainder would push the end away with every press.
	async function showWait(db: IDBDatabase, waitMs: number, fresh: boolean): Promise<void> {
		const running = fresh ? null : clock;
		const left = running?.remainingMs() ?? 0;
		waitText = waitLine(left > 0 ? Math.ceil(left) : waitMs);
		message = waitText;
		if (left <= 0) startWait(db, await readTries(db));
	}

	onMount(() => {
		const db = app.db;
		if (db !== null) {
			readTries(db).then(
				(tries) => {
					if (gone || tries.waitMs <= 0) return;
					waitText = waitLine(tries.waitMs);
					message = waitText;
					startWait(db, tries);
				},
				() => safeLog({ code: 'E_INTERNAL' })
			);
		}
		if (takeFocus) {
			void tick().then(() => {
				if (!gone && document.activeElement === document.body) field?.focus();
			});
		}
		return () => {
			gone = true;
			stopWait();
		};
	});

	// A relock stops the count; the PIN field joins the same list itself to empty its value.
	$effect(() => {
		const join = app.joinRelock;
		if (!join) return;
		return join({ relockSync: stopWait, refresh: () => Promise.resolve() });
	});

	// What one press learned inside the check, for the lines and screens that follow it.
	type Found = {
		noMemory: boolean;
		damagedRow: KeystoreRow | null;
		reloading: boolean;
		session: KeySession | null;
	};

	async function unlock(): Promise<void> {
		const db = app.db;
		if (busy || db === null) return;
		const reload = deps.reload ?? (() => location.reload());
		const pin = value;
		if (app.reloadOnUnlock) {
			// This device's data was replaced from a backup while the page was locked: reading it again would open stale data.
			field?.clear();
			reload();
			return;
		}
		message = null;
		if (!isPinFormat(pin)) {
			message = NOT_RIGHT;
			field?.clear();
			return;
		}
		busy = true;
		const found: Found = { noMemory: false, damagedRow: null, reloading: false, session: null };
		try {
			// The row is read inside the check, under the tries lock, so it is the row this try is counted against.
			const outcome = await runPinCheck(db, async (): Promise<PinCheckResult<true>> => {
				const { row, counter } = await (deps.readRow ?? readPinRowAndCounter)(db);
				if (!row || row.mode !== 'pin') {
					// The lock was removed or the data erased elsewhere: there is no PIN to check.
					found.reloading = true;
					reload();
					return { kind: 'not-counted' };
				}
				try {
					const keys = await (deps.derive ?? derivePinKeys)(pin, { kdf: row.kdf, salt: row.salt });
					const session = await openPinSession(row, keys, counter);
					// Nothing between the open and the set: no task may run while the keys are open and not held.
					setSession(session);
					found.session = session;
					return { kind: 'good', value: true };
				} catch (err) {
					if (err instanceof WrongPinError) return { kind: 'wrong' };
					if (err instanceof PinNoMemoryError) {
						found.noMemory = true;
						return { kind: 'not-counted' };
					}
					if (err instanceof KeystoreHmacMismatchError) {
						found.damagedRow = row;
						return { kind: 'not-counted' };
					}
					throw err;
				}
			});
			if (found.reloading) return;

			if (outcome.kind === 'good') {
				if (!app.unlockStores) throw new Error('E_NOT_READY');
				await app.unlockStores();
				onunlocked?.();
			} else if (outcome.kind === 'wrong') {
				if (outcome.waitMs > 0) await showWait(db, outcome.waitMs, true);
				else message = NOT_RIGHT;
			} else if (outcome.kind === 'waiting') {
				await showWait(db, outcome.waitMs, false);
			} else if (found.noMemory) {
				message = LOW_MEMORY;
			} else if (found.damagedRow) {
				// Only the row this try derived from is damage. If it has changed, another tab wrote it: start over on that.
				const seen = await readStoredBytes(db);
				if (!sameStored(seen.keystore, found.damagedRow)) {
					reload();
				} else {
					if (!app.enterDamaged) throw new Error('E_NOT_READY');
					app.enterDamaged(() => checkStoredBytes(db, seen));
				}
			}
		} catch {
			// The keys were opened inside the check; a failure after that must not leave them behind a card that says no.
			if (found.session !== null && getSession() === found.session) dropSession();
			safeLog({ code: 'E_INTERNAL' });
			message = UNLOCK_FAILED;
		} finally {
			field?.clear();
			busy = false;
		}
	}
</script>

<section class="pin-unlock" aria-labelledby="pin-unlock-heading">
	<h2 id="pin-unlock-heading">Your data is locked</h2>
	<p class="pin-unlock__body">Enter your PIN to open your information.</p>
	<PinField
		bind:this={field}
		bind:value
		id="pin-unlock-field"
		label="PIN"
		joinRelock={app.joinRelock}
		onenter={() => void unlock()}
	/>
	<!-- Not `disabled`: a disabled button that holds focus drops it, so a press while it works is ignored instead. A held
	     Enter's repeats would press again, so only a new press counts; Space clicks on release. -->
	<button
		class="pin-unlock__unlock"
		type="button"
		onclick={() => void unlock()}
		onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
		aria-busy={busy}
	>
		{busy ? 'Unlocking...' : 'Unlock'}
	</button>
	{#if message}<p class="pin-unlock__message" role="alert">{message}</p>{/if}
</section>

<style>
	.pin-unlock {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
		text-align: center;
	}

	.pin-unlock h2 {
		margin: 0;
	}

	.pin-unlock__body {
		margin: 0;
		color: var(--color-fg-muted);
	}

	/* Primary CTA: filled accent + bg-colored text. */
	.pin-unlock__unlock {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.pin-unlock__unlock:hover {
		background: var(--color-accent-muted);
	}

	/* No dim while busy: the label says it is working, and a dim would fade the focus ring or the label below their
	   contrast minimums. The hover fill stays off too, as a press does nothing. */
	.pin-unlock__unlock[aria-busy='true'] {
		background: var(--color-accent);
		cursor: default;
	}

	.pin-unlock__message {
		margin: 0;
		color: var(--color-danger);
	}
</style>
