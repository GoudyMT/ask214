<script module lang="ts">
	import type { derivePinKeys } from '../keystore/pin-derive';
	import type { rotateToPin } from '../keystore/rotate';
	import type { EncryptedStoreName } from '../db/registry';

	/** What a test stands in for: the derive (Argon2id lives in a worker), the move of the records and the clock. */
	export type AppLockDeps = {
		derive?: typeof derivePinKeys;
		rotate?: typeof rotateToPin;
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
	const PACK_LINE = 'Offline SkillBridge listings download again.';

	function storeLine(store: string): string | null {
		if (!Object.hasOwn(CARRIED_NAME, store)) return null;
		const name = CARRIED_NAME[store as keyof typeof CARRIED_NAME];
		return `The PIN was not turned on: your saved ${name} could not be opened. Nothing was changed. Erase all data on this device starts over.`;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { readCounter } from '../keystore/app-lock-store';
	import { setSession } from '../keystore/session';
	import { getProfileApp } from '../profile/context';
	import { loadAppLock } from './load-app-lock';
	import PinField from './PinField.svelte';

	type Props = { deps?: AppLockDeps };
	let { deps = {} }: Props = $props();

	const app = getProfileApp();

	let open = $state(false);
	let first = $state('');
	let second = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);
	let toggleEl = $state<HTMLButtonElement | null>(null);
	let firstField = $state<ReturnType<typeof PinField> | null>(null);
	let secondField = $state<ReturnType<typeof PinField> | null>(null);

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
		if (open) {
			open = false;
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

	async function next(): Promise<void> {
		const db = app.db;
		if (busy) return;
		busy = true;
		message = null;
		const pin = first;
		const again = second;
		// A Lock, an idle lock or a peer's Lock while Next works must not be outlived by the keys it makes. A switch away
		// (hygiene) locks nothing: the hidden-page rule above already covers it during the derive.
		let relocked = false;
		const leave = app.joinRelock?.({
			relockSync: (reason) => {
				if (reason !== 'hygiene') relocked = true;
			},
			refresh: () => Promise.resolve()
		});
		try {
			const [pinDerive, rotation, kdf] = await loadAppLock();
			if (!pinDerive.isPinFormat(pin)) {
				message = FORMAT_LINE;
				return;
			}
			if (pin !== again) {
				message = MISMATCH_LINE;
				return;
			}
			if (db === null) throw new Error('E_NOT_READY');

			const now = deps.now ?? (() => performance.now());
			const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
			hiddenWhileDeriving = document.visibilityState === 'hidden';
			deriving = true;
			const started = now();
			let keys: Awaited<ReturnType<typeof derivePinKeys>>;
			try {
				keys = await (deps.derive ?? pinDerive.derivePinKeys)(pin, { kdf: kdf.KDF_V1, salt });
			} catch (err) {
				if (err instanceof pinDerive.PinNoMemoryError) {
					message = LOW_MEMORY_LINE;
					return;
				}
				throw err;
			} finally {
				deriving = false;
			}
			// A page that was hidden during the derive: the keys are dropped, nothing is written and nothing is said.
			if (hiddenWhileDeriving) return;
			if (now() - started > SETUP_DERIVE_MAX_MS) {
				message = LOW_MEMORY_LINE;
				return;
			}

			const counterBefore = await readCounter(db);
			// A Lock that landed before the move starts: the keys are dropped, nothing is written and nothing is said.
			if (relocked) return;
			const result = await (deps.rotate ?? rotation.rotateToPin)(db, {
				macKey: keys.macKey,
				kek: keys.kek,
				salt,
				kdf: kdf.KDF_V1,
				counterBefore
			});
			if (relocked) {
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
			message = fail(err);
		} finally {
			leave?.();
			firstField?.clear();
			secondField?.clear();
			busy = false;
		}
	}

	function fail(err: unknown): string {
		const store = err instanceof Error && 'store' in err ? String(err.store) : null;
		return (store !== null && storeLine(store)) || FAILED_LINE;
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
		onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
	>
		<span class="app-lock__chevron" class:app-lock__chevron--open={open} aria-hidden="true"></span>
		<span>App lock</span>
		<span class="app-lock__summary">{app.keyMode === 'pin' ? 'PIN on' : 'Off'}</span>
	</button>
	{#if open}
		<div id="app-lock-edit" class="app-lock__edit">
			{#if app.keyMode === 'pin'}
				<p class="app-lock__hint">
					The app asks for your PIN when it opens, after 15 minutes idle, and after Lock.
				</p>
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
						onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}>Next</button
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
	.app-lock__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-s);
	}

	/* Primary CTA: filled accent + bg-colored text. */
	.app-lock__next {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
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
