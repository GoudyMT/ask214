<script module lang="ts">
	import type { createWaitClock as waitClockFn } from '../keystore/app-lock-store';
	import type { derivePinKeys } from '../keystore/pin-derive';
	import type { removePin, rotateToPin } from '../keystore/rotate';
	import type { EncryptedStoreName } from '../db/registry';

	/**
	 * What a test stands in for: the derive (Argon2id lives in a worker), the moves of the records, the clock for the setup
	 * derive's time and the one that counts an owed wait down.
	 */
	export type AppLockDeps = {
		derive?: typeof derivePinKeys;
		rotate?: typeof rotateToPin;
		remove?: typeof removePin;
		clock?: Parameters<typeof waitClockFn>[2];
		now?: () => number;
	};

	// A derive that takes longer than this on a cold, visible page is a phone that cannot hold the PIN: it stays off.
	const SETUP_DERIVE_MAX_MS = 5_000;
	const SALT_BYTES = 16;

	// Each store the move carries, named as a person knows it. Every encrypted store is named here except the one whose
	// rows the move only clears, so a store added to the registry fails the type-check until it is named.
	const CARRIED_NAME: Record<Exclude<EncryptedStoreName, 'skillbridge-finder-pack'>, string> = {
		profile: 'profile',
		'timeline-state': 'timeline',
		'calendar-sync': 'calendar settings',
		byok: 'API key',
		'skillbridge-finder': 'SkillBridge saves'
	};

	const FORMAT_LINE = 'Use 4 to 6 digits.';
	const MISMATCH_LINE = 'The two PINs do not match.';
	const LOW_MEMORY_LINE =
		'This phone does not have enough free memory for a PIN. Close other apps and tabs, then try again.';
	const FAILED_LINE = 'Could not turn on the PIN right now - please try again.';
	const CHANGE_FAILED_LINE = 'Could not change the PIN right now - please try again.';
	const REMOVE_FAILED_LINE = 'Could not remove the PIN right now - please try again.';
	const CHANGED_LINE = 'PIN changed.';
	const REMOVED_LINE = 'PIN removed.';
	const PACK_LINE = 'Offline SkillBridge listings download again.';
	const EASY_LINE = 'This PIN is easy to guess.';
	// What a PIN leaves open, each line whole so none can be shortened into a promise the PIN does not keep.
	const NOT_COVERED = [
		'Ask, Resources and Documents stay open.',
		'It does not protect the data if someone copies it off the phone.',
		'Using the app in another browser? Set a PIN there too.',
		'Calendar events and calendar files you saved are not covered.',
		"Anyone holding your phone can still erase the app's data.",
		'Switching away for a short time does not lock the app. Tap Lock before you hand your phone over.'
	];
	// A line the template would wrap carries the wrap into the page's text; kept here it reads as one line.
	const BACKUP_HINT =
		"If you forget your PIN, your data can't be opened. A backup lets you get it back. Keep the file and its six words together.";

	function storeLine(store: string, done: string): string | null {
		if (!Object.hasOwn(CARRIED_NAME, store)) return null;
		const name = CARRIED_NAME[store as keyof typeof CARRIED_NAME];
		return `The PIN was not ${done}: your saved ${name} could not be opened. Nothing was changed. Erase all data on this device starts over.`;
	}
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { readCounter } from '../keystore/app-lock-store';
	import { isEasyPin } from '../keystore/easy-pin';
	import BackupCard from '../backup/BackupCard.svelte';
	import { backupSession, type Phase } from '../backup/session.svelte';
	import { setSession } from '../keystore/session';
	import { getProfileApp } from '../profile/context';
	import { createCurrentPinCheck } from './current-pin-check';
	import { loadAppLock } from './load-app-lock';
	import PinField from './PinField.svelte';
	import { followWait } from './wait-countdown';

	type Props = {
		deps?: AppLockDeps;
		/** Opens the host's Erase dialog, for the backup card the step mounts. */
		onerase?: () => void;
		/**
		 * True just before the step mounts its backup card (and a tick ahead of it), false once that card has gone. Every
		 * backup card in the tab draws on one session, so a host that shows its own card takes it off the page meanwhile.
		 */
		onbackupstep?: (up: boolean) => void;
	};
	let { deps = {}, onerase, onbackupstep }: Props = $props();
	type Loaded = Awaited<ReturnType<typeof loadAppLock>>;
	type Made = NonNullable<Awaited<ReturnType<typeof deriveNew>>>;

	const app = getProfileApp();

	let open = $state(false);
	// With the PIN on: the plain row, or the form that Change PIN or Remove PIN opened in it.
	let panel = $state<'main' | 'change' | 'remove'>('main');
	let current = $state('');
	let first = $state('');
	let second = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);
	// The easy-PIN warning: which form raised it, and the fields as it found them. The typed PINs stay in their fields while
	// it shows, and any change to them (typing, a relock, a hidden page) ends it, so a Use it anyway never presses over
	// fields that no longer hold the PIN it warned about.
	let easy = $state<{ form: 'setup' | 'change'; seen: string } | null>(null);
	let chooseEl = $state<HTMLButtonElement | null>(null);
	const shown = $derived(easy === null ? message : EASY_LINE);
	$effect(() => {
		if (easy !== null && easy.seen !== `${current},${first},${second}`) easy = null;
	});
	// What a change or a removal did, shown under the row after it closes.
	let statuses = $state<string[]>([]);
	let toggleEl = $state<HTMLButtonElement | null>(null);
	let changeEl = $state<HTMLButtonElement | null>(null);
	let removeEl = $state<HTMLButtonElement | null>(null);
	let currentField = $state<ReturnType<typeof PinField> | null>(null);
	let firstField = $state<ReturnType<typeof PinField> | null>(null);
	let secondField = $state<ReturnType<typeof PinField> | null>(null);
	// The backup step: the keys the PIN derived and the backup card in the button's place. Raw, so the keys are held as they are.
	let held = $state.raw<Made | null>(null);
	let making = $state(false);
	let makeEl = $state<HTMLButtonElement | null>(null);
	let cardEl = $state<HTMLElement | null>(null);
	let leaveHeld: (() => void) | null = null;
	// The host has been told a card is coming and has not yet been told it is gone.
	let cardAnnounced = false;
	// From the save place being asked for to the file being closed: the turn-on moves every record under the keystore lock,
	// so it waits for the backup that is reading them.
	const RUNNING_PHASES: readonly Phase[] = [
		'picking-save',
		'save-chosen',
		'replace-warning',
		'deriving',
		'snapshot',
		'encrypting',
		'verifying',
		'writing'
	];
	const backingUp = $derived(making && RUNNING_PHASES.includes(backupSession.phase));

	// Its wait clock counts an owed wait down while the row is up: nothing else does in Settings, so a wait on the row
	// would never end. The line follows the count while it is still the message shown.
	const pinCheck = untrack(() =>
		createCurrentPinCheck({
			derive: deps.derive,
			clock: deps.clock,
			loadDerive: async () => (await loadAppLock())[0],
			onWaitLine: followWait(
				() => message,
				(line) => (message = line)
			)
		})
	);
	onDestroy(() => pinCheck.stop());

	// Set while a derive runs: a page that was hidden at any moment of it decides nothing for the person.
	let deriving = false;
	let hiddenWhileDeriving = false;

	// Closing unmounts the focused button; focus goes back to the row, so a keyboard user is not dropped - unless they
	// have already moved on to another control.
	async function toToggle(): Promise<void> {
		await tick();
		if (document.activeElement === document.body) toggleEl?.focus();
	}

	async function toggle(): Promise<void> {
		if (busy) return;
		message = null;
		statuses = [];
		if (open) {
			open = false;
			panel = 'main';
			dropHeld();
			await toToggle();
			return;
		}
		open = true;
		await tick();
		firstField?.focus();
	}

	async function cancel(): Promise<void> {
		if (busy) return;
		open = false;
		message = null;
		dropHeld();
		await toToggle();
	}

	// A held Enter repeats, and focus can land on a button under a key already held: only a new press counts.
	const noRepeat = (e: KeyboardEvent) => e.repeat && e.key === 'Enter' && e.preventDefault();

	async function showForm(which: 'change' | 'remove'): Promise<void> {
		if (busy) return;
		message = null;
		panel = which;
		await tick();
		currentField?.focus();
	}

	// Back to the PIN-on row, with focus on the button that opened the form unless the person has moved on.
	async function back(): Promise<void> {
		if (busy) return;
		const was = panel;
		panel = 'main';
		message = null;
		await tick();
		if (document.activeElement === document.body) (was === 'change' ? changeEl : removeEl)?.focus();
	}

	// A Lock, an idle lock or a peer's Lock while a press works must not be outlived by the keys it makes. A switch away
	// (hygiene) locks nothing: the hidden-page rule above already covers it during the derive.
	function watchRelock(): { relocked: () => boolean; leave: () => void } {
		let hit = false;
		const leave = app.joinRelock?.({
			relockSync: (reason) => {
				if (reason !== 'hygiene') hit = true;
			},
			refresh: () => Promise.resolve()
		});
		return { relocked: () => hit, leave: () => leave?.() };
	}

	/**
	 * The setup's derive of a new PIN, on a cold page the person can see. Null when the PIN must not be made: the line is
	 * set when the phone cannot hold the derive, and nothing is said for a page that was hidden during it.
	 */
	async function deriveNew(loaded: Loaded, pin: string) {
		const [pinDerive, , kdf] = loaded;
		const now = deps.now ?? (() => performance.now());
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		hiddenWhileDeriving = document.visibilityState === 'hidden';
		deriving = true;
		const started = now();
		let keys: Awaited<ReturnType<typeof pinDerive.derivePinKeys>>;
		try {
			keys = await (deps.derive ?? pinDerive.derivePinKeys)(pin, { kdf: kdf.KDF_V1, salt });
		} catch (err) {
			if (err instanceof pinDerive.PinNoMemoryError) {
				message = LOW_MEMORY_LINE;
				return null;
			}
			throw err;
		} finally {
			deriving = false;
		}
		// A page that was hidden during the derive: the keys are dropped, nothing is written and nothing is said.
		if (hiddenWhileDeriving) return null;
		if (now() - started > SETUP_DERIVE_MAX_MS) {
			message = LOW_MEMORY_LINE;
			return null;
		}
		return { keys, salt };
	}

	// Held back before anything is derived or counted: the person may take the PIN anyway or choose another. The fields keep
	// what was typed, and focus goes to the safe choice.
	async function warnEasy(form: 'setup' | 'change', typed: string, pin: string, again: string) {
		easy = { form, seen: `${typed},${pin},${again}` };
		await tick();
		chooseEl?.focus();
	}

	// The same press again with the fields as they are; only the easy check is skipped.
	function useAnyway(): void {
		const form = easy?.form;
		easy = null;
		if (form === 'setup') void next(true);
		else if (form === 'change') void press('change', true);
	}

	function chooseAnother(): void {
		easy = null;
		firstField?.clear();
		secondField?.clear();
		firstField?.focus();
	}

	async function next(skipEasy = false): Promise<void> {
		const db = app.db;
		if (busy) return;
		busy = true;
		message = null;
		const pin = first;
		const again = second;
		const watch = watchRelock();
		let warned = false;
		try {
			const loaded = await loadAppLock();
			const [pinDerive] = loaded;
			if (!pinDerive.isPinFormat(pin)) {
				message = FORMAT_LINE;
				return;
			}
			if (pin !== again) {
				message = MISMATCH_LINE;
				return;
			}
			if (!skipEasy && isEasyPin(pin)) {
				warned = true;
				await warnEasy('setup', current, pin, again);
				return;
			}
			if (db === null) throw new Error('E_NOT_READY');

			const made = await deriveNew(loaded, pin);
			if (made === null) return;
			// A Lock that landed during the derive: the keys are dropped, nothing is shown and nothing is said.
			if (watch.relocked()) return;
			// Nothing is turned on yet: the person is first offered a backup, and the derived keys wait for their answer.
			holdKeys(made);
			await tick();
			makeEl?.focus();
		} catch (err) {
			message = fail(err, 'on');
		} finally {
			watch.leave();
			if (!warned) {
				firstField?.clear();
				secondField?.clear();
			}
			busy = false;
		}
	}

	// The PIN's keys, derived on Next and kept (with their salt) while the backup step is up. Dropped when a Lock takes the
	// keys away from the tab, when the row closes or goes, and when the turn-on has run; a switch away keeps them, as the
	// derive is already done and was timed on a page the person could see.
	function holdKeys(made: Made): void {
		dropHeld();
		held = made;
		leaveHeld =
			app.joinRelock?.({
				relockSync: (reason) => {
					if (reason !== 'hygiene') dropHeld();
				},
				refresh: () => Promise.resolve()
			}) ?? null;
	}

	function dropHeld(): void {
		held = null;
		making = false;
		leaveHeld?.();
		leaveHeld = null;
		if (cardAnnounced) {
			cardAnnounced = false;
			onbackupstep?.(false);
		}
	}
	onDestroy(dropHeld);

	// Make a backup and turn on: the backup card takes the button's place and the turn-on waits for its saved report.
	async function startBackup(): Promise<void> {
		if (busy || held === null) return;
		// The host's own card goes first, so it is gone before this one starts the session and cannot cancel it on the way out.
		cardAnnounced = true;
		onbackupstep?.(true);
		await tick();
		// A Lock during that tick has dropped the keys, and the host already heard it.
		if (held === null) return;
		making = true;
		await tick();
		cardEl?.querySelector('button')?.focus();
	}

	/**
	 * The turn-on, with the keys the step holds: the records move onto them, this tab holds the new session and the other
	 * tabs hear of it. Skip and turn on presses it, and so does the backup card once it reports a saved backup.
	 */
	async function turnOn(): Promise<void> {
		const db = app.db;
		const kept = held;
		// A saved report that arrives after the keys were dropped (a Lock, the row closing) finds nothing to turn on.
		if (busy || kept === null) return;
		busy = true;
		message = null;
		// A backup begun here must not outlive the move into PIN mode, where making one asks for the PIN. A write that has
		// begun is not cut short (the session's end leaves it), and the turn-on does not wait for it: Skip is off while a run is
		// going, and a saved backup has finished writing.
		if (making) {
			backupSession.end();
			// The card goes with its open control: nothing on it can start an export while the records move.
			making = false;
		}
		const watch = watchRelock();
		let turnedOn = false;
		try {
			const [, rotation, kdf] = await loadAppLock();
			if (db === null) throw new Error('E_NOT_READY');
			const counterBefore = await readCounter(db);
			// A Lock that landed before the move starts: the keys are dropped, nothing is written and nothing is said.
			if (watch.relocked()) return;
			const result = await (deps.rotate ?? rotation.rotateToPin)(db, {
				macKey: kept.keys.macKey,
				kek: kept.keys.kek,
				salt: kept.salt,
				kdf: kdf.KDF_V1,
				counterBefore
			});
			turnedOn = true;
			if (watch.relocked()) {
				// A Lock that landed during the move, which may have committed: the PIN is on, and this tab was locked
				// before it could hold the new keys, so it shows the PIN card and the other tabs read the new row.
				app.publish?.({ type: 'keys-changed' });
				app.keyMode = 'pin';
				app.pinLocked = true;
			} else {
				// Nothing between the move and the session: the old keys are gone and the new ones are not yet held.
				setSession(result.session);
				app.publish?.({ type: 'keys-changed' });
				app.keyMode = 'pin';
			}
			// In PIN mode no export runs without a good PIN: one opened while the PIN was off (here or on the page's own card)
			// ends with the move. A save that has begun is never cut short, so the session's end leaves it.
			if (backupSession.kind === 'export') backupSession.end();
			if (result.packHadFiles) message = PACK_LINE;
			await toToggle();
		} catch (err) {
			message = fail(err, 'on');
		} finally {
			watch.leave();
			dropHeld();
			busy = false;
		}
		// A turn-on that did not happen puts the form back: the pressed button went with the step, and focus goes to the PIN.
		if (!turnedOn && app.keyMode !== 'pin') {
			await tick();
			if (document.activeElement === document.body) firstField?.focus();
		}
	}

	// Change PIN and Remove PIN. Both check the current PIN first; neither sets the session the check opened.
	async function press(kind: 'change' | 'remove', skipEasy = false): Promise<void> {
		const db = app.db;
		if (busy) return;
		busy = true;
		message = null;
		statuses = [];
		const typed = current;
		const pin = first;
		const again = second;
		const watch = watchRelock();
		let warned = false;
		try {
			const loaded = await loadAppLock();
			const [pinDerive, rotation, kdf] = loaded;
			if (kind === 'change') {
				if (!pinDerive.isPinFormat(pin)) {
					message = FORMAT_LINE;
					return;
				}
				if (pin !== again) {
					message = MISMATCH_LINE;
					return;
				}
				// Before the current PIN is checked, so a warning costs no try.
				if (!skipEasy && isEasyPin(pin)) {
					warned = true;
					await warnEasy('change', typed, pin, again);
					return;
				}
			}
			if (db === null) throw new Error('E_NOT_READY');
			const checked = await pinCheck.check(
				db,
				typed,
				kind === 'change' ? CHANGE_FAILED_LINE : REMOVE_FAILED_LINE
			);
			if (!checked.ok) {
				message = checked.line;
				return;
			}
			const opened = checked.session;
			// Said at once, so a failure later in this press still leaves it under the row.
			statuses = checked.notice;

			if (kind === 'change') {
				// A Lock during the check: the new PIN is not derived for a tab that is locked.
				if (watch.relocked()) return;
				const made = await deriveNew(loaded, pin);
				if (made === null) return;
				const counterBefore = await readCounter(db);
				// A Lock that landed before the move starts: the keys are dropped, nothing is written and nothing is said.
				if (watch.relocked()) return;
				const result = await (deps.rotate ?? rotation.rotateToPin)(db, {
					macKey: made.keys.macKey,
					kek: made.keys.kek,
					salt: made.salt,
					kdf: kdf.KDF_V1,
					counterBefore
				});
				if (watch.relocked()) {
					// A Lock that landed during the move, which may have committed: this tab was locked before it could hold
					// the new keys, so it shows the PIN card and the other tabs read the new row.
					app.publish?.({ type: 'keys-changed' });
					app.pinLocked = true;
				} else {
					// Nothing between the move and the session: the old keys are gone and the new ones are not yet held.
					setSession(result.session);
					app.publish?.({ type: 'keys-changed' });
				}
				statuses = [CHANGED_LINE, ...checked.notice, ...(result.packHadFiles ? [PACK_LINE] : [])];
			} else {
				const counterBefore = await readCounter(db);
				// A Lock during the check or before the removal starts: nothing is written and nothing is said.
				if (watch.relocked()) return;
				await (deps.remove ?? rotation.removePin)(db, { session: opened, counterBefore });
				// A Lock during the removal leaves this tab locked as it was; a tab still unlocked reads the local row next time.
				if (!watch.relocked()) app.keyMode = 'local';
				app.publish?.({ type: 'keys-changed' });
				statuses = [REMOVED_LINE, ...checked.notice];
			}
			open = false;
			panel = 'main';
			await toToggle();
		} catch (err) {
			message = fail(err, kind);
		} finally {
			watch.leave();
			if (!warned) {
				currentField?.clear();
				firstField?.clear();
				secondField?.clear();
			}
			busy = false;
		}
	}

	function fail(err: unknown, kind: 'on' | 'change' | 'remove'): string {
		if (kind === 'remove') return REMOVE_FAILED_LINE;
		const store = err instanceof Error && 'store' in err ? String(err.store) : null;
		const named = store === null ? null : storeLine(store, kind === 'on' ? 'turned on' : 'changed');
		return named ?? (kind === 'on' ? FAILED_LINE : CHANGE_FAILED_LINE);
	}
</script>

<svelte:document
	onvisibilitychange={() => {
		if (deriving && document.visibilityState === 'hidden') hiddenWhileDeriving = true;
	}}
/>

{#snippet easyChoices()}
	<!-- Held keys: the Next or Change PIN that raised the warning hands focus to the first button, and a repeat of Enter must
	     not press it; only a new press counts. -->
	<div class="app-lock__actions">
		<button
			bind:this={chooseEl}
			class="app-lock__next"
			type="button"
			onclick={chooseAnother}
			onkeydown={noRepeat}>Choose another</button
		>
		<button class="app-lock__cancel" type="button" onclick={useAnyway} onkeydown={noRepeat}
			>Use it anyway</button
		>
	</div>
{/snippet}

<div class="app-lock">
	<!-- Opening hands focus to the first field and a turn-on hands it back here mid-press, so a held Enter's repeats would
	     press again: only a new press toggles. -->
	<button
		bind:this={toggleEl}
		class="app-lock__toggle"
		type="button"
		aria-expanded={open}
		aria-controls="app-lock-edit"
		onclick={() => void toggle()}
		onkeydown={noRepeat}
	>
		<span class="app-lock__chevron" class:app-lock__chevron--open={open} aria-hidden="true"></span>
		<span>App lock</span>
		<span class="app-lock__summary">{app.keyMode === 'pin' ? 'PIN on' : 'Off'}</span>
	</button>
	<!-- What a change or a removal did stays here after the row closes. -->
	<div class="app-lock__status" role="status">
		{#each statuses as line (line)}<p class="app-lock__hint">{line}</p>{/each}
	</div>
	{#if open}
		<div id="app-lock-edit" class="app-lock__edit">
			{#if app.keyMode === 'pin' && (panel === 'main' || app.pinLocked === true)}
				<p class="app-lock__hint">
					The app asks for your PIN when it opens, after 15 minutes idle, and after Lock.
				</p>
				<!-- Both need the saved data open, so a locked screen has the line alone. -->
				{#if app.pinLocked !== true}
					<div class="app-lock__actions">
						<button
							bind:this={changeEl}
							class="app-lock__secondary"
							type="button"
							onclick={() => void showForm('change')}
							onkeydown={noRepeat}>Change PIN</button
						>
						<button
							bind:this={removeEl}
							class="app-lock__remove"
							type="button"
							onclick={() => void showForm('remove')}
							onkeydown={noRepeat}>Remove PIN</button
						>
					</div>
				{/if}
			{:else if app.keyMode === 'pin'}
				{#if panel === 'remove'}
					<p class="app-lock__strong">Remove your PIN?</p>
					<p class="app-lock__hint">
						Anyone with your phone can open the app. Your data stays on this device.
					</p>
				{/if}
				<PinField
					bind:this={currentField}
					bind:value={current}
					id="app-lock-current"
					label="Enter your current PIN"
					joinRelock={app.joinRelock}
					onenter={() => (panel === 'remove' ? void press('remove') : firstField?.focus())}
				/>
				{#if panel === 'change'}
					<PinField
						bind:this={firstField}
						bind:value={first}
						id="app-lock-new"
						label="Choose a 4-6 digit PIN"
						joinRelock={app.joinRelock}
						onenter={() => secondField?.focus()}
					/>
					<PinField
						bind:this={secondField}
						bind:value={second}
						id="app-lock-again"
						label="Enter it again"
						joinRelock={app.joinRelock}
						onenter={() => void press('change')}
					/>
				{/if}
				<!-- Held keys: a repeat of Enter must not press again over the emptied fields; only a new press counts. -->
				{#if easy !== null}
					{@render easyChoices()}
				{:else}
					<div class="app-lock__actions">
						<button
							class="app-lock__next"
							type="button"
							aria-busy={busy}
							onclick={() => void press(panel === 'remove' ? 'remove' : 'change')}
							onkeydown={noRepeat}>{panel === 'remove' ? 'Remove PIN' : 'Change PIN'}</button
						>
						<button
							class="app-lock__cancel"
							type="button"
							disabled={busy}
							onclick={() => void back()}>Cancel</button
						>
					</div>
				{/if}
			{:else if held !== null}
				<p class="app-lock__strong">One more step: make a backup</p>
				<p class="app-lock__hint">{BACKUP_HINT}</p>
				<!-- Held keys: the Next that brought the step up hands focus to its first button, and a repeat of Enter must not
				     press it; only a new press counts. -->
				<div class="app-lock__actions">
					{#if making}
						<div class="app-lock__backup" bind:this={cardEl}>
							<BackupCard
								db={app.db}
								onEraseRequest={() => onerase?.()}
								only={{ row: 'export', label: 'Make a backup and turn on', open: true }}
								onsaved={() => void turnOn()}
							/>
						</div>
					{:else}
						<button
							bind:this={makeEl}
							class="app-lock__next"
							type="button"
							aria-busy={busy}
							onclick={() => void startBackup()}
							onkeydown={noRepeat}>Make a backup and turn on</button
						>
					{/if}
					<button
						class="app-lock__cancel"
						type="button"
						disabled={backingUp}
						onclick={() => void turnOn()}
						onkeydown={noRepeat}>Skip and turn on</button
					>
				</div>
			{:else}
				<p class="app-lock__hint">
					A PIN keeps other people out of your saved information on this phone.
				</p>
				<p class="app-lock__hint">Don't use your phone's unlock PIN.</p>
				<details class="app-lock__fold">
					<summary>What a PIN does not cover</summary>
					<ul>
						{#each NOT_COVERED as line (line)}<li>{line}</li>{/each}
					</ul>
				</details>
				<PinField
					bind:this={firstField}
					bind:value={first}
					id="app-lock-new"
					label="Choose a 4-6 digit PIN"
					joinRelock={app.joinRelock}
					onenter={() => secondField?.focus()}
				/>
				<PinField
					bind:this={secondField}
					bind:value={second}
					id="app-lock-again"
					label="Enter it again"
					joinRelock={app.joinRelock}
					onenter={() => void next()}
				/>
				<!-- A held Enter repeats, and Next keeps focus after a failure: each repeat would press it again over the
				     emptied fields and replace the answer. Only a new press counts. -->
				{#if easy !== null}
					{@render easyChoices()}
				{:else}
					<div class="app-lock__actions">
						<button
							class="app-lock__next"
							type="button"
							aria-busy={busy}
							onclick={() => void next()}
							onkeydown={noRepeat}>Next</button
						>
						<button
							class="app-lock__cancel"
							type="button"
							disabled={busy}
							onclick={() => void cancel()}>Cancel</button
						>
					</div>
				{/if}
			{/if}
			<!-- The wait line's seconds change inside a child that is not live: the alert is spoken when it appears, not on every tick. -->
			{#if shown}<p class="app-lock__message" role="alert">
					<span aria-live="off">{shown}</span>
				</p>{/if}
		</div>
	{/if}
</div>

<style>
	/* The same caret-expand idiom as the Settings date rows, so the in-place edits read as siblings. */
	.app-lock__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg);
		font: inherit;
		font-size: var(--font-size-s);
		cursor: pointer;
		text-align: left;
	}
	.app-lock__summary {
		margin-left: auto;
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	.app-lock__chevron {
		width: 0;
		height: 0;
		border-left: 5px solid currentColor;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		flex: none;
	}
	.app-lock__chevron--open {
		transform: rotate(90deg);
	}

	.app-lock__edit {
		display: flex;
		flex-direction: column;
		gap: var(--space-s);
		margin: var(--space-s) 0 var(--space-l);
	}
	.app-lock__hint {
		margin: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.app-lock__strong {
		margin: 0;
		font-weight: 600;
	}
	/* What a change or a removal did, under the closed row. It stays on the page when empty, so a screen reader is
	   already watching it when the line arrives; it only gives up its space. */
	.app-lock__status {
		margin: var(--space-s) 0 var(--space-l);
	}
	.app-lock__status:empty {
		margin: 0;
	}
	.app-lock__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-s);
	}

	/* Primary CTA: filled accent + bg-colored text. The border is clear and takes a pixel of the padding, so the button
	   is the size it was: forced colors repaint a clear border in a system colour, which keeps a filled button's edge
	   when its fill is taken away. */
	.app-lock__next {
		padding: calc(var(--space-s) - 1px) calc(var(--space-l) - 1px);
		background: var(--color-accent);
		color: var(--color-bg);
		border: 1px solid transparent;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.app-lock__next:hover {
		background: var(--color-accent-muted);
	}
	/* No dim while busy: a dim would fade the focus ring or the label below their contrast minimums. The hover fill
	   stays off too, as a press does nothing. */
	.app-lock__next[aria-busy='true'] {
		background: var(--color-accent);
		cursor: default;
	}

	/* What a PIN does not cover: closed until asked for, with a summary the size of a touch target. */
	.app-lock__fold {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.app-lock__fold summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		color: var(--color-fg);
		cursor: pointer;
	}
	.app-lock__fold ul {
		margin: 0 0 var(--space-s);
		padding-left: 1.2em;
	}

	/* The backup card takes a whole line, and Skip and turn on wraps under it. */
	.app-lock__backup {
		flex: 1 1 100%;
		min-width: 0;
	}

	/* The two choices of a PIN that is on: bordered, so each keeps its edge under forced colors, and Remove stands apart. */
	.app-lock__secondary,
	.app-lock__remove {
		padding: var(--space-s) var(--space-l);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
		cursor: pointer;
	}
	.app-lock__secondary {
		color: var(--color-fg);
		font-weight: 600;
	}
	.app-lock__remove {
		margin-left: auto;
		color: var(--color-danger);
	}

	/* Quiet CTA: muted text, underline. */
	.app-lock__cancel {
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.app-lock__cancel:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.app-lock__message {
		margin: 0;
		color: var(--color-danger);
	}
</style>
