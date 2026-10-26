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

	function storeLine(store: string, done: string): string | null {
		if (!Object.hasOwn(CARRIED_NAME, store)) return null;
		const name = CARRIED_NAME[store as keyof typeof CARRIED_NAME];
		return `The PIN was not ${done}: your saved ${name} could not be opened. Nothing was changed. Erase all data on this device starts over.`;
	}
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { readCounter } from '../keystore/app-lock-store';
	import { setSession } from '../keystore/session';
	import { getProfileApp } from '../profile/context';
	import { createCurrentPinCheck } from './current-pin-check';
	import { loadAppLock } from './load-app-lock';
	import PinField from './PinField.svelte';

	type Props = { deps?: AppLockDeps };
	let { deps = {} }: Props = $props();
	type Loaded = Awaited<ReturnType<typeof loadAppLock>>;

	const app = getProfileApp();

	let open = $state(false);
	// With the PIN on: the plain row, or the form that Change PIN or Remove PIN opened in it.
	let panel = $state<'main' | 'change' | 'remove'>('main');
	let current = $state('');
	let first = $state('');
	let second = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);
	// What a change or a removal did, shown under the row after it closes.
	let statuses = $state<string[]>([]);
	let toggleEl = $state<HTMLButtonElement | null>(null);
	let changeEl = $state<HTMLButtonElement | null>(null);
	let removeEl = $state<HTMLButtonElement | null>(null);
	let currentField = $state<ReturnType<typeof PinField> | null>(null);
	let firstField = $state<ReturnType<typeof PinField> | null>(null);
	let secondField = $state<ReturnType<typeof PinField> | null>(null);

	// Its wait clock counts an owed wait down while the row is up: nothing else does in Settings, so a wait on the row
	// would never end.
	const pinCheck = untrack(() =>
		createCurrentPinCheck({
			derive: deps.derive,
			clock: deps.clock,
			loadDerive: async () => (await loadAppLock())[0]
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

	async function next(): Promise<void> {
		const db = app.db;
		if (busy) return;
		busy = true;
		message = null;
		const pin = first;
		const again = second;
		const watch = watchRelock();
		try {
			const loaded = await loadAppLock();
			const [pinDerive, rotation, kdf] = loaded;
			if (!pinDerive.isPinFormat(pin)) {
				message = FORMAT_LINE;
				return;
			}
			if (pin !== again) {
				message = MISMATCH_LINE;
				return;
			}
			if (db === null) throw new Error('E_NOT_READY');

			const made = await deriveNew(loaded, pin);
			if (made === null) return;
			const { keys, salt } = made;

			const counterBefore = await readCounter(db);
			// A Lock that landed before the move starts: the keys are dropped, nothing is written and nothing is said.
			if (watch.relocked()) return;
			const result = await (deps.rotate ?? rotation.rotateToPin)(db, {
				macKey: keys.macKey,
				kek: keys.kek,
				salt,
				kdf: kdf.KDF_V1,
				counterBefore
			});
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
			if (result.packHadFiles) message = PACK_LINE;
			await toToggle();
		} catch (err) {
			message = fail(err, 'on');
		} finally {
			watch.leave();
			firstField?.clear();
			secondField?.clear();
			busy = false;
		}
	}

	// Change PIN and Remove PIN. Both check the current PIN first; neither sets the session the check opened.
	async function press(kind: 'change' | 'remove'): Promise<void> {
		const db = app.db;
		if (busy) return;
		busy = true;
		message = null;
		statuses = [];
		const typed = current;
		const pin = first;
		const again = second;
		const watch = watchRelock();
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
				statuses = result.packHadFiles ? [CHANGED_LINE, PACK_LINE] : [CHANGED_LINE];
			} else {
				const counterBefore = await readCounter(db);
				// A Lock during the check or before the removal starts: nothing is written and nothing is said.
				if (watch.relocked()) return;
				await (deps.remove ?? rotation.removePin)(db, { session: opened, counterBefore });
				// A Lock during the removal leaves this tab locked as it was; a tab still unlocked reads the local row next time.
				if (!watch.relocked()) app.keyMode = 'local';
				app.publish?.({ type: 'keys-changed' });
				statuses = [REMOVED_LINE];
			}
			open = false;
			panel = 'main';
			await toToggle();
		} catch (err) {
			message = fail(err, kind);
		} finally {
			watch.leave();
			currentField?.clear();
			firstField?.clear();
			secondField?.clear();
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
				<div class="app-lock__actions">
					<button
						class="app-lock__next"
						type="button"
						aria-busy={busy}
						onclick={() => void press(panel === 'remove' ? 'remove' : 'change')}
						onkeydown={noRepeat}>{panel === 'remove' ? 'Remove PIN' : 'Change PIN'}</button
					>
					<button class="app-lock__cancel" type="button" disabled={busy} onclick={() => void back()}
						>Cancel</button
					>
				</div>
			{:else}
				<p class="app-lock__hint">
					A PIN keeps other people out of your saved information on this phone.
				</p>
				<p class="app-lock__hint">Don't use your phone's unlock PIN.</p>
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
			{#if message}<p class="app-lock__message" role="alert">{message}</p>{/if}
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
