<script lang="ts">
	import { onMount } from 'svelte';
	import {
		CARD_LABELS,
		DEVICE_NEWER_WARNING,
		madeOnLine,
		NOT_IN_BACKUPS,
		NOT_IN_BACKUPS_LEAD,
		ONLY_RESTORE_YOURS_LINE,
		summaryLines
	} from './copy';
	import type { ConfirmHold } from './restore-flow';
	import type { BackupSession } from './session.svelte';

	type Props = {
		session: BackupSession;
		confirm: ConfirmHold;
		/** The line for the reason the details were read again, or null. */
		notice: string | null;
		onreplace: () => void;
		/** Back to the words: the dialog closed by Cancel or Escape. Nothing was written. */
		onback: () => void;
	};
	let { session, confirm, notice, onreplace, onback }: Props = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let cancelEl = $state<HTMLButtonElement | null>(null);

	onMount(() => {
		dialog?.showModal();
		// Cancel is the safe choice and the default: Enter on a dialog that just opened must not replace anything.
		cancelEl?.focus();
		return session.registerConfirm(() => dialog?.close());
	});
</script>

<!-- A held Enter on the field that opened this puts its repeats on Cancel, and Cancel hands focus back to that field:
     only a new press may press anything here. The dialog only filters its controls' keys; it is not a control itself.
     Escape asks the dialog to cancel, which here means what the Cancel button means. -->
<dialog
	bind:this={dialog}
	class="confirm"
	translate="no"
	aria-labelledby="backup-confirm-heading"
	aria-describedby="backup-confirm-state"
	onkeydown={(e) => e.repeat && e.key === 'Enter' && e.preventDefault()}
	oncancel={(e) => {
		e.preventDefault();
		onback();
	}}
>
	<h2 id="backup-confirm-heading" class="confirm__heading">{CARD_LABELS.restore}</h2>
	<p class="confirm__line">{madeOnLine(confirm.summary.madeOn)}</p>
	{#if confirm.summary.label !== null}
		<p class="confirm__line">{CARD_LABELS.backupName}: {confirm.summary.label}</p>
	{/if}
	<ul class="confirm__list">
		{#each summaryLines(confirm.summary) as line (line)}
			<li>{line}</li>
		{/each}
	</ul>
	<!-- What a screen reader reads after the name: what this device holds, the warning that its changes are newer, and the
	     reason the details were read again. -->
	<div id="backup-confirm-state">
		<p class="confirm__line">{confirm.deviceLine}</p>
		{#if confirm.warning}
			<p class="confirm__line confirm__line--warning">{DEVICE_NEWER_WARNING}</p>
		{/if}
		{#if notice !== null}
			<p class="confirm__line" role="alert">{notice}</p>
		{/if}
	</div>
	<p class="confirm__line">{ONLY_RESTORE_YOURS_LINE}</p>
	<p class="confirm__line confirm__line--lead">{NOT_IN_BACKUPS_LEAD}</p>
	<ul class="confirm__list">
		{#each NOT_IN_BACKUPS as item (item)}
			<li>{item}</li>
		{/each}
	</ul>
	<div class="confirm__actions">
		<button bind:this={cancelEl} class="confirm__cancel" type="button" onclick={onback}>
			{CARD_LABELS.cancel}
		</button>
		<button class="confirm__replace" type="button" onclick={onreplace}>
			{CARD_LABELS.replace}
		</button>
	</div>
</dialog>

<style>
	.confirm {
		max-width: 28rem;
		padding: var(--space-l);
		background: var(--color-surface);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
	}
	.confirm::backdrop {
		background: rgb(0 0 0 / 0.5);
	}
	.confirm__heading {
		margin: 0 0 var(--space-m);
	}
	.confirm__line {
		margin: 0 0 var(--space-s);
	}
	.confirm__line--lead {
		margin-top: var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.confirm__line--warning {
		color: var(--color-danger);
	}
	.confirm__list {
		margin: 0 0 var(--space-s);
		padding-left: var(--space-l);
		color: var(--color-fg-muted);
	}
	.confirm__actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-m);
		margin-top: var(--space-l);
	}
	/* Cancel is the prominent, focused default (filled primary) so the safe choice is the obvious one - the same
	   pattern as the Erase dialog. */
	.confirm__cancel {
		min-height: 44px;
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.confirm__cancel:hover {
		background: var(--color-accent-muted);
	}
	/* The destructive choice is quiet danger text: available, but it takes deliberate aim. */
	.confirm__replace {
		min-height: 44px;
		padding: var(--space-s);
		background: none;
		border: none;
		color: var(--color-danger);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
