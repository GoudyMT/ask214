<script module lang="ts">
	import { ExportFlow } from './export-flow';
	import { RestoreFlow } from './restore-flow';
	import type { BackupSession } from './session.svelte';

	// What outlives one card. The flows hold the person's place (a wrong passphrase's offer, a replace warning waiting
	// for its answer), and the session survives the card being taken off the page behind a lock, so the card that
	// comes back on Unlock must find the same flows. Keyed by session, so a test's own session starts clean.
	// The flows work on one database connection, so they are kept only for the connection they were built on: a card
	// given another connection (a test, or a host that opens its own) starts them fresh. The app has one, so a page does
	// not meet this.
	// The result of a backup is kept too: the person may put the phone down just after pressing Save, and the card is gone
	// when the file's answer arrives. It is written here by the code that receives the answer, not by anything that
	// mirrors the card's own state, because that card may no longer exist.
	type ExportOutcome =
		| {
				kind: 'saved';
				fileName: string;
				readBack: 'matches' | 'mismatch' | 'not-checked' | 'download';
				/** When the words appeared: the date the backup carries, and the one its Last backup mark would show. */
				at: number;
				/**
				 * The sealed file, ciphertext only. Held while the result is on screen, and while a lock has only taken the card
				 * off the page; the page that shows the card drops it with `forgetResult` when the person leaves.
				 */
				text: string;
		  }
		| { kind: 'line'; text: string };

	type Kept = {
		db: IDBDatabase | null;
		restore: RestoreFlow | null;
		exporter: ExportFlow | null;
		warningName: string;
		outcome: ExportOutcome | null;
		/** The browser refused to send the file of `outcome`; it goes with that one result. */
		refused: boolean;
	};
	const kept = new WeakMap<BackupSession, Kept>();

	function keptFor(session: BackupSession): Kept {
		let found = kept.get(session);
		if (found === undefined) {
			found = {
				db: null,
				restore: null,
				exporter: null,
				warningName: '',
				outcome: null,
				refused: false
			};
			kept.set(session, found);
		}
		return found;
	}

	/**
	 * The person has left the page that shows the card: a result kept for the card's return is theirs to come back to only
	 * within the visit, and a lock taken in the middle of it ends no visit, so the card cannot tell the two apart itself.
	 */
	export function forgetResult(session: BackupSession): void {
		keptFor(session).outcome = null;
	}
</script>

<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { getProfileApp } from '../profile/context';
	import { readDeviceState } from '../profile/device-state';
	import { TASK_DEFS } from '../timeline/task-defs';
	import type { BackupCode } from './codes';
	import {
		backupMessage,
		CARD_INTRO_LINE,
		CARD_LABELS,
		CHECK_NEW_BACKUP_OFFER,
		downloadedLine,
		ERASE_DEVICE_BUTTON,
		GETTING_READY_LINE,
		HIDDEN_WHILE_AWAY_LINE,
		KEEP_WORDS_LINE,
		lastBackupLine,
		MAKE_NEW_BACKUP_BUTTON,
		NO_BACKUP_YET_LINE,
		NOT_IN_BACKUPS,
		NOT_IN_BACKUPS_LEAD,
		notCheckedLine,
		savedLine,
		SEND_REFUSED_DOWNLOADS_LINE,
		SEND_REFUSED_FOLDER_LINE,
		STOPPING_LINE,
		TYPE_BACK_LINE,
		type MessageContext
	} from './copy';
	import { formatBackupDate } from './dates';
	import type { ExportDeps, ExportResult } from './export-flow';
	import PhraseBlock from './PhraseBlock.svelte';
	import type { FlowDeps } from './restore-flow';
	import RestoreConfirm from './RestoreConfirm.svelte';
	import { backupSession, type Phase, type SessionKind } from './session.svelte';

	type Props = {
		/** Opens the host's Erase dialog: the damaged-device line offers it. */
		onEraseRequest: () => void;
		/** The open database. A backup and a restore need it; a Check does not. */
		db: IDBDatabase | null;
		/** Defaults to the app the layout provides. */
		app?: FlowDeps['app'];
		/** Defaults to the tab's one backup session. */
		session?: BackupSession;
		/** The seams a test stands in for (the save picker, the download, the read-back time). */
		exportDeps?: Omit<ExportDeps, 'session' | 'db' | 'profile'>;
		restoreDeps?: Omit<FlowDeps, 'session' | 'app' | 'db'>;
		/**
		 * The form of the card for a host that offers one row: that row alone, with no heading, intro or list, under
		 * `label` (the row's own name when none is given). The restore row is drawn without the card's own frame, for the
		 * setup screen, which has one; the Check row keeps it. With `open` set, the row opens by itself, once, as soon as
		 * it can start.
		 */
		only?: { row: 'restore' | 'check'; label?: string; open?: boolean };
	};
	const props: Props = $props();

	// The session, the app and the restore flow live as long as the card: a later change of a prop does not rebuild
	// them, because the flow holds the person's place in a restore.
	const session = untrack(() => props.session ?? backupSession);
	const app = untrack(() => props.app ?? getProfileApp());
	const memo = keptFor(session);
	const startDb = untrack(() => props.db);
	if (memo.restore === null || memo.db !== startDb) {
		memo.db = startDb;
		memo.exporter = null;
		memo.outcome = null;
		memo.restore = untrack(
			() => new RestoreFlow({ session, app, db: props.db, ...props.restoreDeps })
		);
	}
	const restore: RestoreFlow = memo.restore;

	// ---- what the card shows --------------------------------------------------------------------------------------

	const SHOW_PHASES: readonly Phase[] = [
		'phrase-hidden',
		'generating',
		'phrase-shown',
		'typed-back'
	];
	// The type-back stays mounted through key work, so a stopped run returns to it with the typed text still there.
	const EXPORT_FORM_PHASES: readonly Phase[] = [
		'phrase-shown',
		'typed-back',
		'picking-save',
		'save-chosen',
		'replace-warning',
		'deriving',
		'snapshot',
		'encrypting',
		'verifying',
		'writing'
	];
	const FILE_FORM_PHASES: readonly Phase[] = [
		'file-chosen',
		'deriving',
		'decrypting',
		'confirm',
		'writing'
	];
	// Choose file stays after a choice, so a wrong file can be swapped for another.
	const CHOOSE_PHASES: readonly Phase[] = ['choose-file', 'file-chosen'];
	const WORKING_PHASES: readonly Phase[] = [
		'deriving',
		'snapshot',
		'encrypting',
		'verifying',
		'decrypting',
		'writing'
	];

	let exportOutcome = $state<ExportOutcome | null>(memo.outcome);
	// Set once the card has gone for good (the person moved to another page): a result that arrives after that has no
	// card to come back to, and the sealed text must not wait in memory for one.
	let leftForGood = false;
	// The browser refused to send this result's file. It belongs to one result, so every new result clears it.
	let sendRefused = $state(memo.refused);
	let refusedEl = $state<HTMLElement | null>(null);
	function setOutcome(next: ExportOutcome | null): void {
		if (!leftForGood) memo.outcome = next;
		sendRefused = false;
		exportOutcome = next;
	}
	// A word that did not match, said beside the field; the session keeps nothing about it.
	let inputError = $state<string | null>(null);
	let warningName = $state(memo.warningName);
	// The time the words appeared, held from then: the session forgets it when the backup ends, before the result arrives.
	let madeAt = 0;
	// The name and the refusal are mirrored into `memo` so a card brought back over the same session still names the file
	// and still knows the browser would not send it.
	$effect(() => {
		memo.warningName = warningName;
		memo.refused = sendRefused;
		madeAt = session.backupAt ?? madeAt;
	});
	let startLine = $state<string | null>(null);
	// Undefined until the mark has been read; null when the device has none.
	let lastBackup = $state<number | null | undefined>(undefined);
	// Which path an idle session's last message belongs to: a cleared session forgets its kind.
	let lastKind = $state<SessionKind | null>(null);

	let exportPassEl = $state<HTMLInputElement | null>(null);
	let filePassEl = $state<HTMLInputElement | null>(null);
	let showEl = $state<HTMLButtonElement | null>(null);
	let phraseRef = $state<{ focus: () => void } | null>(null);
	let resultEl = $state<HTMLElement | null>(null);
	let warningEl = $state<HTMLElement | null>(null);
	let checkedEl = $state<HTMLElement | null>(null);

	const view = $derived(restore.view);
	const kind = $derived(session.kind);
	const phase = $derived(session.phase);
	const concealed = $derived(session.concealed);

	const makeOpen = $derived(kind === 'export' || exportOutcome !== null);
	const showingWords = $derived(
		kind === 'export' && session.revealed && !concealed && session.words !== null
	);
	const showShow = $derived(kind === 'export' && !showingWords && SHOW_PHASES.includes(phase));
	const exportForm = $derived(kind === 'export' && EXPORT_FORM_PHASES.includes(phase));
	const fileKind = $derived(kind === 'restore' || kind === 'check');
	const fileForm = $derived(fileKind && FILE_FORM_PHASES.includes(phase));
	const chooser = $derived(fileKind && CHOOSE_PHASES.includes(phase));
	const working = $derived(session.busy && WORKING_PHASES.includes(phase));
	// Not behind the confirm (it has its own Cancel) and not on a finished Check (the row's toggle closes it).
	const cancellable = $derived(session.canCancel && phase !== 'done' && phase !== 'confirm');

	function lineFor(code: BackupCode, ctx: MessageContext): string {
		try {
			const text = backupMessage(code, ctx);
			if (text !== null) return text;
		} catch {
			/* a detail the flow could not give is the flow's fault; the person still gets a line */
		}
		// A code with no text of its own yet says that the step stopped and nothing was changed.
		return backupMessage('E_WORKER_FAILED', { path: ctx.path }) ?? '';
	}

	const exportLine = $derived.by(() => {
		if (exportOutcome?.kind === 'line') return exportOutcome.text;
		if (kind === 'export' && session.message !== null) {
			return lineFor(session.message, { path: 'export' });
		}
		return null;
	});

	const fileLine = $derived.by(() => {
		if (!fileKind) return null;
		if (view.line !== null) return view.line;
		if (session.message === null) return null;
		return lineFor(session.message, { path: kind === 'check' ? 'check' : 'restore' });
	});

	// What a session that is already over left to say: a lock, a stop, a cancel.
	const idleLine = $derived.by(() => {
		if (startLine !== null) return startLine;
		if (session.active || session.message === null) return null;
		return lineFor(session.message, { path: lastKind === 'export' ? 'export' : 'restore' });
	});

	const confirmNotice = $derived.by(() => {
		const code = view.confirm?.notice ?? null;
		return code === null ? null : restore.lineFor(code);
	});

	// A row does nothing the app cannot protect: no relock set, a start-up still running, or (for a restore) no way
	// to tell the other tabs. Guarded here as well as disabled in look, as the wizard's entries are.
	function allowed(row: SessionKind): boolean {
		if (app.joinRelock === null) return false;
		if (row === 'check') return app.status === 'ready' || app.status === 'damaged';
		if (app.status !== 'ready' || props.db === null) return false;
		if (row === 'restore') return app.publish !== null;
		return app.store !== null;
	}

	function isOpen(row: SessionKind): boolean {
		return row === 'export' ? makeOpen : kind === row;
	}

	// Not `disabled`: a disabled button that holds focus drops it. The tap is guarded in `toggleRow` and `openRow`, and
	// a screen reader is told the row is off.
	function isInert(row: SessionKind): boolean {
		return !isOpen(row) && (!allowed(row) || session.active);
	}

	// ---- keeping the card in step ---------------------------------------------------------------------------------

	$effect(() => {
		if (kind !== null) lastKind = kind;
	});

	// The session wipes these on a real stop (a Lock, a Cancel, leaving the page) and never on an app switch.
	$effect(() => (exportPassEl === null ? undefined : session.registerInput(exportPassEl)));
	$effect(() => (filePassEl === null ? undefined : session.registerInput(filePassEl)));

	// A wrong passphrase puts the cursor back in the field with its text kept.
	let focusSeen = untrack(() => restore.view.focusField);
	$effect(() => {
		const bump = view.focusField;
		if (bump === focusSeen) return;
		focusSeen = bump;
		void tick().then(() => filePassEl?.focus());
	});

	async function refreshMark(): Promise<void> {
		if (props.db === null) return;
		try {
			lastBackup = (await readDeviceState(props.db)).mark?.at ?? null;
		} catch {
			lastBackup = undefined;
		}
	}
	onMount(() => void refreshMark());

	// Leaving the page ends the session; an app switch that only swaps the card out leaves it (the session knows). Read
	// in a microtask: this teardown runs inside the batch that took the card off the page, where a state read still
	// returns the value from before the batch. So a card taken off by a lock would read an unlocked profile, and
	// would write "the page was left" over the lock that took it.
	onDestroy(() =>
		queueMicrotask(() => {
			// A card taken off behind a lock or an app switch comes back; one taken off with the profile open went with the page.
			// "Locked" is a profile that exists and is not open: a first-run device reads 'locked' after another tab idles, with
			// nothing to unlock and no card to come back to.
			const locked = !!app.store?.locked;
			leftForGood = !locked;
			if (leftForGood) memo.outcome = null;
			session.cardGone({ locked });
		})
	);

	// ---- rows -----------------------------------------------------------------------------------------------------

	function openRow(row: SessionKind): void {
		startLine = null;
		if (!allowed(row)) return;
		setOutcome(null);
		inputError = null;
		try {
			if (row === 'export') session.start(app, 'export');
			else
				void restore.open(row).catch(() => {
					startLine = lineFor('E_WORKER_FAILED', { path: 'restore' });
				});
		} catch {
			// A refused start says the step stopped; "finish setup" is only for a snapshot that found the setup unfinished.
			startLine = lineFor('E_WORKER_FAILED', { path: 'export' });
		}
	}

	// A pressed button that leaves the page drops focus to the top of the page. Focus goes to the row's own toggle instead,
	// unless the person (or the step that followed) already put it somewhere.
	async function handFocusToRow(row: SessionKind | null): Promise<void> {
		await tick();
		if (document.activeElement === document.body) {
			document.getElementById(`backup-toggle-${row}`)?.focus();
		}
	}

	function closeRow(): void {
		if (session.stopping) return;
		const row = kind;
		if (session.canCancel) session.cancel('user-cancel');
		else restore.close();
		setOutcome(null);
		inputError = null;
		warningName = '';
		void handFocusToRow(row);
	}

	function toggleRow(row: SessionKind): void {
		if (isOpen(row)) {
			closeRow();
			return;
		}
		if (session.active || session.stopping) return;
		openRow(row);
	}

	// A host that shows one row can ask for it to be open. It opens once, as soon as the row can start (the app may
	// still be starting when the card mounts), and never again: a row the person closed stays closed.
	let autoOpened = false;
	$effect(() => {
		const only = props.only;
		if (only?.open !== true || autoOpened || !allowed(only.row)) return;
		autoOpened = true;
		untrack(() => {
			if (!session.active) openRow(only.row);
		});
	});

	const guardEnter = (e: KeyboardEvent): void => {
		if (e.repeat && e.key === 'Enter') e.preventDefault();
	};

	// ---- Make a backup --------------------------------------------------------------------------------------------

	function exportFlowFor(): ExportFlow | null {
		if (memo.exporter !== null) return memo.exporter;
		if (props.db === null || app.store === null) return null;
		memo.exporter = new ExportFlow({
			session,
			db: props.db,
			profile: app.store,
			...props.exportDeps
		});
		return memo.exporter;
	}

	async function show(): Promise<void> {
		await session.showPassphrase();
		await tick();
		if (session.revealed) phraseRef?.focus();
	}

	async function hide(): Promise<void> {
		session.revealed = false;
		await tick();
		showEl?.focus();
	}

	function taskTitle(taskId: string): string | undefined {
		return TASK_DEFS.find((def) => def.id === taskId)?.title;
	}

	async function applyExport(result: ExportResult): Promise<void> {
		switch (result.kind) {
			case 'ignored':
			case 'cancelled':
			case 'stopped':
				return;
			case 'invalid': {
				const ctx: MessageContext = { path: 'export' };
				if (result.position !== undefined) ctx.position = result.position;
				if (result.numbers !== undefined) ctx.numbers = result.numbers;
				inputError = lineFor(result.code, ctx);
				await tick();
				exportPassEl?.focus();
				return;
			}
			case 'replace-warning':
				warningName = result.fileName;
				await tick();
				warningEl?.focus();
				return;
			case 'failed': {
				const ctx: MessageContext = { path: 'export' };
				if (result.store !== undefined) ctx.store = result.store;
				if (result.taskId !== undefined) {
					const title = taskTitle(result.taskId);
					if (title !== undefined) ctx.taskTitle = title;
				}
				setOutcome({ kind: 'line', text: lineFor(result.code, ctx) });
				break;
			}
			case 'saved':
				setOutcome({
					kind: 'saved',
					fileName: result.fileName,
					readBack: result.readBack,
					at: madeAt,
					text: result.text
				});
				void refreshMark();
				break;
		}
		await tick();
		resultEl?.focus();
	}

	function submitExport(event: SubmitEvent): void {
		const flow = exportFlowFor();
		if (flow === null) {
			event.preventDefault();
			return;
		}
		inputError = null;
		if (exportOutcome?.kind === 'line') setOutcome(null);
		// Everything up to the save picker is synchronous inside the flow: the browser opens it only for this tap.
		void flow.submit(event, exportPassEl?.value ?? '').then(applyExport);
	}

	function replaceIt(): void {
		void exportFlowFor()?.replace().then(applyExport);
	}

	// The second tap of a double tap (`detail` 2) may land after a back-out brought this warning back, and would open
	// the picker again.
	function chooseAnother(event: MouseEvent): void {
		if (event.detail > 1) return;
		void exportFlowFor()?.chooseAnother().then(applyExport);
	}

	// The result's own buttons: the one that was pressed goes with the result, so focus goes to the row it opened.
	function offer(row: SessionKind): void {
		setOutcome(null);
		openRow(row);
		void handFocusToRow(row);
	}

	// The three lines that tell the person to delete a file live here, not in copy.ts: that module's test refuses the
	// word in anything it exports. What each says:
	//   - KEEP_NEWEST_LINE: shown under every saved line, so an older file does not linger beside a newer one;
	//   - replaceWarningLine: the warning before saving over a file that already holds something;
	//   - mismatchLine: the result when the saved file does not read back as what was written.
	const KEEP_NEWEST_LINE = 'Keep the newest. Delete older files.';
	const replaceWarningLine = (name: string): string =>
		'There is already a file named ' +
		name +
		' there. Replacing it deletes what it holds, which may be an older backup.';
	const mismatchLine = (name: string): string =>
		'Saved as ' +
		name +
		', but the saved file does not match, so it may not open. Make a new backup to another place. You can delete ' +
		name +
		'.';

	function savedText(o: Extract<ExportOutcome, { kind: 'saved' }>): string {
		switch (o.readBack) {
			case 'matches':
				return savedLine(o.fileName);
			case 'download':
				return downloadedLine(o.fileName);
			case 'not-checked':
				return notCheckedLine(o.fileName);
			case 'mismatch':
				return mismatchLine(o.fileName);
		}
	}

	// "Send a copy": offered only on the two lines that vouch for the file (read back, or handed to the downloads), and
	// only where the browser says it would accept this very file. Asked once per result, not on every render.
	const shareFile = $derived.by(() => {
		const outcome = exportOutcome;
		if (outcome?.kind !== 'saved') return null;
		if (outcome.readBack !== 'matches' && outcome.readBack !== 'download') return null;
		const file = new File([outcome.text], outcome.fileName, { type: 'application/json' });
		try {
			return navigator.canShare?.({ files: [file] }) === true ? file : null;
		} catch {
			return null;
		}
	});

	// Called straight from the tap, so the browser still counts the tap as the person's own act. A back-out (an
	// AbortError) says nothing and leaves the button. Any other refusal means the button would only fail again, so it
	// goes and the line says where to find the file; the file is saved either way. The button had focus, so the line
	// takes it.
	async function sendCopy(): Promise<void> {
		const file = shareFile;
		if (file === null) return;
		try {
			await navigator.share({ files: [file] });
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') return;
			sendRefused = true;
			await tick();
			refusedEl?.focus();
		}
	}

	// ---- Restore and Check ----------------------------------------------------------------------------------------

	async function submitFile(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		await restore.submit(filePassEl?.value ?? '');
		await tick();
		checkedEl?.focus();
	}

	// Once a file is chosen the next thing to do is type the words, so focus goes to the box. Not while the page is
	// hidden (the form is not shown then), and not when the pick ended in the choose step (a cancelled or unreadable file).
	async function chooseFile(): Promise<void> {
		await restore.chooseFile();
		await tick();
		if (session.phase === 'file-chosen' && !concealed) filePassEl?.focus();
	}

	// Back to the words with the text kept: the key and the confirm are dropped, nothing was written.
	async function backOut(): Promise<void> {
		const run = session.beginRun();
		if (run === null) return;
		run.toPre();
		run.release();
		await tick();
		filePassEl?.focus();
	}

	function makeNewBackup(): void {
		restore.close();
		offer('export');
	}
</script>

<section
	class="backup-card"
	class:backup-card--bare={props.only?.row === 'restore'}
	translate="no"
	aria-labelledby={props.only === undefined ? 'backup-heading' : undefined}
	aria-label={props.only === undefined
		? undefined
		: (props.only.label ?? (props.only.row === 'check' ? CARD_LABELS.check : CARD_LABELS.restore))}
>
	{#if props.only === undefined}
		<h2 id="backup-heading" class="backup-card__heading">{CARD_LABELS.heading}</h2>
		<p class="backup-hint">{CARD_INTRO_LINE}</p>
		<!-- A save made while the page was hidden could not record its date, and an older date (or "No backup yet.") beside
		     its own saved line would deny it. -->
		{#if lastBackup !== undefined && !(exportOutcome?.kind === 'saved' && (lastBackup ?? 0) < exportOutcome.at)}
			<p class="backup-hint backup-last">
				{lastBackup === null ? NO_BACKUP_YET_LINE : lastBackupLine(formatBackupDate(lastBackup))}
			</p>
		{/if}
	{/if}
	{#if session.stopping}
		<p class="backup-hint" role="status">{STOPPING_LINE}</p>
	{:else if idleLine !== null}
		<p class="backup-hint" role="status">{idleLine}</p>
	{/if}

	{#snippet toggleRowButton(row: SessionKind, label: string, controls: string)}
		<button
			id="backup-toggle-{row}"
			class="backup-toggle"
			class:backup-toggle--off={isInert(row)}
			type="button"
			aria-expanded={isOpen(row)}
			aria-disabled={isInert(row)}
			aria-controls={controls}
			onclick={() => toggleRow(row)}
			onkeydown={guardEnter}
		>
			<span class="backup-chevron" class:backup-chevron--open={isOpen(row)} aria-hidden="true"
			></span>
			<span>{label}</span>
		</button>
	{/snippet}

	{#snippet progressBar()}
		{#if working}
			<progress
				class="backup-progress"
				max="100"
				value={session.progress ?? undefined}
				aria-labelledby="backup-toggle-{kind}"
			></progress>
		{/if}
	{/snippet}

	{#snippet cancelButton()}
		{#if cancellable}
			<button class="backup-cancel" type="button" onclick={closeRow} onkeydown={guardEnter}>
				{CARD_LABELS.cancel}
			</button>
		{/if}
	{/snippet}

	{#snippet hiddenLine()}
		{#if concealed}
			<p class="backup-hint" role="status">{HIDDEN_WHILE_AWAY_LINE}</p>
		{/if}
	{/snippet}

	{#snippet fileBody(row: 'restore' | 'check')}
		{@render hiddenLine()}
		{#if phase === 'getting-ready'}
			<p class="backup-hint" role="status">{GETTING_READY_LINE}</p>
		{/if}
		{#if chooser}
			<button
				class="backup-primary"
				type="button"
				hidden={concealed}
				onclick={() => void chooseFile()}
				onkeydown={guardEnter}
			>
				{CARD_LABELS.chooseFile}
			</button>
		{/if}
		{#if fileForm}
			<!-- A held Enter repeats, and a wrong passphrase hands focus back to the field mid-press: only a new press
			     submits. The form only filters its controls' keys; it is not a control itself. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<form
				class="backup-form"
				aria-label={row === 'restore' ? CARD_LABELS.restore : CARD_LABELS.check}
				hidden={concealed}
				onsubmit={(e) => void submitFile(e)}
				onkeydown={guardEnter}
			>
				{#if view.label !== null}
					<label class="backup-field">
						<span>{CARD_LABELS.backupName}</span>
						<input
							type="text"
							readonly
							autocomplete="username"
							spellcheck="false"
							value={view.label}
						/>
					</label>
				{/if}
				<label class="backup-field">
					<span>{CARD_LABELS.passphrase}</span>
					<input
						bind:this={filePassEl}
						type="password"
						autocomplete="current-password"
						autocapitalize="none"
						autocorrect="off"
						spellcheck="false"
						enterkeyhint="done"
						aria-invalid={fileLine !== null}
						aria-describedby={fileLine !== null ? 'backup-file-error' : undefined}
					/>
				</label>
				<div class="backup-actions">
					<button class="backup-primary" type="submit" aria-busy={session.busy}>
						{row === 'restore' ? CARD_LABELS.restoreSubmit : CARD_LABELS.checkSubmit}
					</button>
				</div>
			</form>
		{/if}
		{@render progressBar()}
		{#if fileLine !== null}
			<p id="backup-file-error" class="backup-error" role="alert">{fileLine}</p>
		{/if}
		{#if view.offerNewBackup}
			<p class="backup-hint">{CHECK_NEW_BACKUP_OFFER}</p>
			<button class="backup-primary" type="button" onclick={makeNewBackup} onkeydown={guardEnter}>
				{MAKE_NEW_BACKUP_BUTTON}
			</button>
		{/if}
		{#if view.offerErase}
			<button
				class="backup-quiet-danger"
				type="button"
				onclick={() => props.onEraseRequest()}
				onkeydown={guardEnter}
			>
				{ERASE_DEVICE_BUTTON}
			</button>
		{/if}
		{#if view.checked !== null}
			<p class="backup-result" role="status" tabindex="-1" bind:this={checkedEl}>
				{view.checked.line}
			</p>
		{/if}
		{#if view.restored !== null}
			{#if view.restored.line !== null}
				<p class="backup-result" role="status">{view.restored.line}</p>
			{/if}
			{#if view.restored.reloadButton}
				<button
					class="backup-primary"
					type="button"
					onclick={() => restore.reloadNow()}
					onkeydown={guardEnter}
				>
					{CARD_LABELS.reload}
				</button>
			{/if}
		{/if}
		{@render cancelButton()}
		{#if view.confirm !== null}
			<RestoreConfirm
				{session}
				confirm={view.confirm}
				notice={confirmNotice}
				onreplace={() => void restore.replace()}
				onback={() => void backOut()}
			/>
		{/if}
	{/snippet}

	<!-- Make a backup -->
	{#if props.only === undefined}
		<div class="backup-row">
			{@render toggleRowButton('export', CARD_LABELS.make, 'backup-make')}
			{#if makeOpen}
				<div id="backup-make" class="backup-body">
					{@render hiddenLine()}
					{#if showShow}
						<p class="backup-hint" hidden={concealed}>{KEEP_WORDS_LINE}</p>
						<button
							bind:this={showEl}
							class="backup-primary"
							type="button"
							hidden={concealed}
							aria-busy={phase === 'generating'}
							onclick={() => void show()}
							onkeydown={guardEnter}
						>
							{CARD_LABELS.show}
						</button>
					{/if}
					{#if showingWords && session.words !== null}
						<PhraseBlock bind:this={phraseRef} words={session.words} onhide={() => void hide()} />
					{/if}
					{#if exportForm}
						<!-- A held Enter repeats, and each repeat would ask for the save place again once the last try ended: only
					     a new press submits. The form only filters its controls' keys; it is not a control itself. -->
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<form
							class="backup-form"
							aria-label={CARD_LABELS.make}
							hidden={concealed}
							onsubmit={submitExport}
							onkeydown={guardEnter}
						>
							<p class="backup-hint">{TYPE_BACK_LINE}</p>
							<label class="backup-field">
								<span>{CARD_LABELS.backupName}</span>
								<input
									type="text"
									readonly
									autocomplete="username"
									spellcheck="false"
									value={session.names?.label ?? ''}
								/>
							</label>
							<label class="backup-field">
								<span>{CARD_LABELS.passphrase}</span>
								<input
									bind:this={exportPassEl}
									type="password"
									autocomplete="new-password"
									autocapitalize="none"
									autocorrect="off"
									spellcheck="false"
									enterkeyhint="done"
									aria-invalid={inputError !== null}
									aria-describedby={inputError !== null ? 'backup-make-error' : undefined}
								/>
							</label>
							{#if inputError !== null}
								<p id="backup-make-error" class="backup-error" role="alert">{inputError}</p>
							{/if}
							<div class="backup-actions">
								<button class="backup-primary" type="submit" aria-busy={session.busy}>
									{CARD_LABELS.make}
								</button>
							</div>
						</form>
					{/if}
					{#if phase === 'replace-warning'}
						<div class="backup-warning" role="alert" tabindex="-1" bind:this={warningEl}>
							<p>{replaceWarningLine(warningName)}</p>
							<div class="backup-actions">
								<button
									class="backup-primary"
									type="button"
									onclick={chooseAnother}
									onkeydown={guardEnter}
								>
									{CARD_LABELS.chooseAnother}
								</button>
								<button
									class="backup-quiet-danger"
									type="button"
									onclick={replaceIt}
									onkeydown={guardEnter}
								>
									{CARD_LABELS.replaceIt}
								</button>
							</div>
						</div>
					{/if}
					{@render progressBar()}
					{#if exportLine !== null}
						<p class="backup-error" role="alert" tabindex="-1" bind:this={resultEl}>{exportLine}</p>
					{/if}
					{#if exportOutcome?.kind === 'saved'}
						<p class="backup-result" role="status" tabindex="-1" bind:this={resultEl}>
							{savedText(exportOutcome)}
						</p>
						<p class="backup-hint">{KEEP_NEWEST_LINE}</p>
						{#if sendRefused}
							<p class="backup-hint" role="status" tabindex="-1" bind:this={refusedEl}>
								{exportOutcome.readBack === 'download'
									? SEND_REFUSED_DOWNLOADS_LINE
									: SEND_REFUSED_FOLDER_LINE}
							</p>
						{/if}
						<div class="backup-actions">
							{#if shareFile !== null && !sendRefused}
								<button
									class="backup-primary"
									type="button"
									onclick={() => void sendCopy()}
									onkeydown={guardEnter}
								>
									{CARD_LABELS.send}
								</button>
							{/if}
							{#if exportOutcome.readBack === 'mismatch'}
								<button
									class="backup-primary"
									type="button"
									onclick={() => offer('export')}
									onkeydown={guardEnter}
								>
									{CARD_LABELS.makeAgain}
								</button>
							{:else}
								<button
									class="backup-primary"
									type="button"
									onclick={() => offer('check')}
									onkeydown={guardEnter}
								>
									{CARD_LABELS.checkNow}
								</button>
							{/if}
						</div>
					{/if}
					{@render cancelButton()}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Restore from a backup -->
	{#if props.only === undefined || props.only.row === 'restore'}
		<div class="backup-row">
			{@render toggleRowButton(
				'restore',
				props.only?.label ?? CARD_LABELS.restore,
				'backup-restore'
			)}
			{#if kind === 'restore'}
				<div id="backup-restore" class="backup-body">
					{@render fileBody('restore')}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Check a backup -->
	{#if props.only === undefined || props.only.row === 'check'}
		<div class="backup-row">
			{@render toggleRowButton('check', props.only?.label ?? CARD_LABELS.check, 'backup-check')}
			{#if kind === 'check'}
				<div id="backup-check" class="backup-body">
					{@render fileBody('check')}
				</div>
			{/if}
		</div>
	{/if}

	{#if props.only === undefined}
		<p class="backup-hint backup-lead">{NOT_IN_BACKUPS_LEAD}</p>
		<ul class="backup-not-in">
			{#each NOT_IN_BACKUPS as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.backup-card {
		margin-top: var(--space-l);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}
	/* On the setup screen the card sits inside the screen's own frame, so it takes none of its own. */
	.backup-card--bare {
		margin-top: 0;
		padding: 0;
		background: none;
		border: none;
		border-radius: 0;
	}
	/* A class on a form, button or paragraph that sets `display` beats the browser's own rule for the hidden
	   attribute, and a hidden form would then still show. Scoped to the card, never the whole app. */
	.backup-card :global([hidden]) {
		display: none !important;
	}
	.backup-card__heading {
		margin: 0 0 var(--space-m);
	}
	.backup-hint {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.backup-lead {
		margin: var(--space-l) 0 var(--space-s);
	}
	.backup-not-in {
		margin: 0;
		padding-left: var(--space-l);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}

	.backup-row {
		border-top: 1px solid var(--color-border);
	}
	/* The same caret-expand idiom as the Settings date rows and the Calendar panel. */
	.backup-toggle {
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
		text-align: left;
		cursor: pointer;
	}
	.backup-toggle--off {
		color: var(--color-fg-muted);
		cursor: default;
	}
	/* Forced colors paint the muted grey as ordinary text, so a row that is off would read like a live one. */
	@media (forced-colors: active) {
		.backup-toggle--off {
			color: GrayText;
		}
	}
	.backup-chevron {
		width: 0;
		height: 0;
		border-left: 5px solid currentColor;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		flex: none;
	}
	.backup-chevron--open {
		transform: rotate(90deg);
	}

	.backup-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-m);
		padding-bottom: var(--space-m);
	}
	.backup-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-m);
		width: 100%;
	}
	.backup-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
	}
	.backup-field input {
		padding: var(--space-s);
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
	}
	.backup-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
	}

	/* The border is clear and takes a pixel of the padding, so the button is the size it was: forced colors repaint a clear
	   border in a system colour, which keeps a filled button's edge when its fill is taken away. */
	.backup-primary {
		min-height: 44px;
		padding: calc(var(--space-s) - 1px) calc(var(--space-l) - 1px);
		background: var(--color-accent);
		color: var(--color-bg);
		border: 1px solid transparent;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.backup-primary:hover {
		background: var(--color-accent-muted);
	}
	/* No dim while busy: a dim would fade the focus ring or the label below their contrast minimums. */
	.backup-primary[aria-busy='true'] {
		background: var(--color-accent);
		cursor: default;
	}
	.backup-cancel {
		min-height: 44px;
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.backup-quiet-danger {
		min-height: 44px;
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-danger);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.backup-error {
		margin: 0;
		color: var(--color-danger);
	}
	.backup-result {
		margin: 0;
	}
	.backup-result:focus-visible,
	.backup-error:focus-visible,
	.backup-warning:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.backup-warning {
		width: 100%;
	}
	.backup-progress {
		width: 100%;
	}
</style>
