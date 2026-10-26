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

	/**
	 * What a test stands in for: the derive (Argon2id lives in a worker), the row read, the wait clock, the reload, and
	 * the fetch of the Forgot screen's restore (a fetch can fail offline).
	 */
	export type PinUnlockDeps = {
		derive?: (
			pin: string,
			params: { kdf: KdfTuple; salt: Uint8Array }
		) => Promise<{ macKey: CryptoKey; kek: CryptoKey }>;
		readRow?: typeof readPinRowAndCounter;
		clock?: Parameters<typeof createWaitClock>[2];
		reload?: () => void;
		loadRestore?: () => Promise<
			[typeof import('../backup/BackupCard.svelte'), typeof import('../keystore/forgot-restore')]
		>;
	};
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { getProfileApp } from '../profile/context';
	import PinField from './PinField.svelte';
	import { CHECK_LOW_MEMORY_LINE, NOT_RIGHT_LINE, waitLine } from './pin-lines';

	type Props = {
		/** After the stores loaded; the page moves focus on, since this card is about to go. */
		onunlocked?: () => void;
		/** Set when focus is on its way here from a button that is about to go (Lock): the cursor goes to the field. */
		takeFocus?: boolean;
		/** "Erase and start over" on the Forgot screen: the page opens its Erase. */
		onerase?: () => void;
		/** True while the Forgot screen is up, false when it closes or the card goes. */
		onforgot?: (open: boolean) => void;
		deps?: PinUnlockDeps;
	};
	let { onunlocked, takeFocus = false, onerase, onforgot, deps = {} }: Props = $props();

	const app = getProfileApp();

	const NOT_RIGHT = NOT_RIGHT_LINE;
	const LOW_MEMORY = CHECK_LOW_MEMORY_LINE;
	const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
	const RESTORE_OPEN_FAILED = 'Could not open the restore right now - please try again.';

	let value = $state('');
	let field = $state<ReturnType<typeof PinField> | null>(null);
	let busy = $state(false);
	let message = $state<string | null>(null);

	// The Forgot screen takes the card's place. The backup card and the writer for a locked device are fetched only when
	// the person asks to restore: the Unlock card's own code carries neither.
	type RestoreCard = (typeof import('../backup/BackupCard.svelte'))['default'];
	let forgot = $state(false);
	let forgotHeadingEl = $state<HTMLElement | null>(null);
	let restore = $state.raw<{
		Card: RestoreCard;
		deps: {
			lockedDevice: {
				read: typeof import('../keystore/forgot-restore').readLockedDevice;
				write: typeof import('../keystore/forgot-restore').restoreLockedDevice;
			};
		};
	} | null>(null);
	let restoreFailed = $state(false);

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
			dropWaiting();
		};
	});

	// The page shows no line of its own above the Forgot screen; its end is told on every way out, the card going included.
	$effect(() => {
		if (!forgot) return;
		onforgot?.(true);
		return () => onforgot?.(false);
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

	// A held Enter would press the control focus lands on for every repeat: only a new press counts.
	const guardEnter = (e: KeyboardEvent): void => {
		if (e.repeat && e.key === 'Enter') e.preventDefault();
	};

	// The page's Erase opens with its focus on Cancel, so a key still held when it opens would press Cancel on every repeat.
	// The erase is handed over once an Enter that is down has been let go. Space clicks on release, so nothing is held then.
	let enterDown = false;
	// At most one erase waits for a release. It is dropped whenever the key's release can no longer be what it waited for.
	let waiting: ((e: KeyboardEvent) => void) | null = null;
	const trackEnter = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') enterDown = e.type === 'keydown';
	};
	function dropWaiting(): void {
		if (waiting) removeEventListener('keyup', waiting, true);
		waiting = null;
	}
	// A key let go while another window (the file picker a held Enter opened) has the focus is never seen here: the key is
	// not down any more, whatever the last keydown said, and an erase waiting for it would answer some later Enter instead.
	function forgetHeldEnter(): void {
		enterDown = false;
		dropWaiting();
	}
	const forgetWhenHidden = (): void => {
		if (document.visibilityState === 'hidden') forgetHeldEnter();
	};
	function handOver(): void {
		if (!enterDown) {
			onerase?.();
			return;
		}
		if (waiting) return;
		const release = (e: KeyboardEvent): void => {
			if (e.key !== 'Enter') return;
			dropWaiting();
			onerase?.();
		};
		waiting = release;
		addEventListener('keyup', release, true);
	}

	// The Unlock form goes with its field, which empties itself as it goes. Focus goes to the new screen's heading, a thing
	// nothing presses, so a key still held from the button that opened it does nothing there.
	async function openForgot(): Promise<void> {
		if (busy) return;
		forgot = true;
		await tick();
		forgotHeadingEl?.focus();
	}

	function backToUnlock(): void {
		restore = null;
		restoreFailed = false;
		forgot = false;
		dropWaiting();
		void tick().then(() => field?.focus());
	}

	// The backup card and the locked-device writer come on demand: the Unlock card's own chunk carries neither.
	const loadRestore = () =>
		import('./load-backup').then((all) => [all, all] as [typeof all, typeof all]);

	async function showRestore(): Promise<void> {
		if (restore !== null) return;
		try {
			const [card, locked] = await (deps.loadRestore ?? loadRestore)();
			if (gone || !forgot) return;
			restoreFailed = false;
			restore = {
				Card: card.default,
				deps: { lockedDevice: { read: locked.readLockedDevice, write: locked.restoreLockedDevice } }
			};
			// The button the person pressed is gone: focus goes to the row that took its place.
			await tick();
			document.getElementById('backup-toggle-restore')?.focus();
		} catch {
			// The files come from the app's cache; a fetch that fails offline says so and the person can try again.
			safeLog({ code: 'E_INTERNAL' });
			restoreFailed = true;
		}
	}
</script>

<svelte:window onkeydowncapture={trackEnter} onkeyupcapture={trackEnter} onblur={forgetHeldEnter} />
<svelte:document onvisibilitychange={forgetWhenHidden} />

<section class="pin-unlock" aria-labelledby={forgot ? 'pin-forgot-heading' : 'pin-unlock-heading'}>
	{#if !forgot}
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
			onkeydown={guardEnter}
			aria-busy={busy}
		>
			{busy ? 'Unlocking...' : 'Unlock'}
		</button>
		{#if message}<p class="pin-unlock__message" role="alert">{message}</p>{/if}
		<button
			class="pin-unlock__quiet"
			type="button"
			onclick={() => void openForgot()}
			onkeydown={guardEnter}>Forgot PIN?</button
		>
	{:else}
		<h2 id="pin-forgot-heading" tabindex="-1" bind:this={forgotHeadingEl}>Forgot your PIN?</h2>
		<p class="pin-unlock__body">
			Your PIN is not saved anywhere, so no one can reset it. You have two ways back.
		</p>
		{#if restore !== null}
			{@const Card = restore.Card}
			<div class="pin-unlock__card">
				<Card
					db={app.db}
					onEraseRequest={handOver}
					only={{ row: 'restore', label: 'Restore from a backup', open: true }}
					restoreDeps={restore.deps}
				/>
			</div>
		{:else}
			<button
				class="pin-unlock__restore"
				type="button"
				onclick={() => void showRestore()}
				onkeydown={guardEnter}>Restore from a backup</button
			>
			<p class="pin-unlock__hint">Uses a backup file you saved and its six words.</p>
		{/if}
		{#if restoreFailed}<p class="pin-unlock__message" role="alert">{RESTORE_OPEN_FAILED}</p>{/if}
		<button class="pin-unlock__danger" type="button" onclick={handOver} onkeydown={guardEnter}
			>Erase and start over</button
		>
		<p class="pin-unlock__hint">
			Removes everything saved on this device, so the app can start again.
		</p>
		<button class="pin-unlock__quiet" type="button" onclick={backToUnlock} onkeydown={guardEnter}
			>Back to Unlock</button
		>
	{/if}
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

	/* Primary CTA: filled accent + bg-colored text. The border is clear and takes a pixel of the padding, so the button
	   is the size it was: forced colors repaint a clear border in a system colour, which keeps a filled button's edge
	   when its fill is taken away. */
	.pin-unlock__unlock,
	.pin-unlock__restore {
		padding: calc(var(--space-s) - 1px) calc(var(--space-l) - 1px);
		background: var(--color-accent);
		color: var(--color-bg);
		border: 1px solid transparent;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.pin-unlock__unlock:hover,
	.pin-unlock__restore:hover {
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

	.pin-unlock__quiet {
		min-height: 44px;
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	/* The border is a real one, in the danger colour, so the button keeps its edge when forced colors take the colour. */
	.pin-unlock__danger {
		padding: var(--space-s) var(--space-l);
		background: none;
		color: var(--color-danger);
		border: 1px solid var(--color-danger);
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.pin-unlock__hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	/* The backup card is drawn without a frame of its own, across the card, with its text from the left. */
	.pin-unlock__card {
		width: 100%;
		text-align: left;
	}
</style>
