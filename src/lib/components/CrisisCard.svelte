<!--
  Crisis-line card. Shown when the on-device crisis detector flags a message; the message is never
  stored, searched, or sent. The contacts are fixed, safety-critical constants verified against the
  official Veterans Crisis Line (veteranscrisisline.net): dial 988 then press 1, text 838255, chat, 911.
  Calm/supportive tone by design (not alarm-red). The links are native tel:/sms:/external - no backend.
-->
<div class="crisis" role="alert">
	<div class="crisis__head">
		<svg
			class="crisis__glyph"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"
		>
			<path
				d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l1.7 1.7L12 21.5l7.1-7.1 1.7-1.7a5 5 0 0 0 0-7.1z"
			/>
		</svg>
		<h2 class="crisis__title">You're not alone - support is here now</h2>
	</div>
	<p class="crisis__body">
		If you're in crisis or thinking about harming yourself, please reach out. Talking with someone
		right now is free, confidential, and available any time.
	</p>
	<div class="crisis__actions">
		<a class="crisis__btn" href="tel:988">Call 988, then press 1</a>
		<a class="crisis__btn crisis__btn--ghost" href="sms:838255">Text 838255</a>
		<a
			class="crisis__btn crisis__btn--ghost"
			href="https://www.veteranscrisisline.net/get-help-now/chat/"
			target="_blank"
			rel="external noopener"
		>
			Chat online
		</a>
	</div>
	<p class="crisis__danger">In immediate danger? Call <a href="tel:911">911</a>.</p>
	<p class="crisis__note">
		This is the Veterans/Military Crisis Line. Detected on your device - your message wasn't sent or
		searched.
	</p>
</div>

<style>
	.crisis {
		background: var(--color-surface);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}
	.crisis__head {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-bottom: var(--space-xs);
	}
	.crisis__glyph {
		flex: none;
		width: 22px;
		height: 22px;
		color: var(--color-accent);
	}
	.crisis__title {
		font-size: var(--font-size-l);
		margin: 0;
	}
	.crisis__body {
		font-size: var(--font-size-s);
		color: var(--color-fg);
		margin: 0 0 var(--space-m);
	}
	.crisis__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-s);
	}
	.crisis__btn {
		display: inline-flex;
		align-items: center;
		background: var(--color-accent);
		color: var(--color-bg);
		border: 1px solid var(--color-accent);
		border-radius: var(--radius-m);
		padding: 10px var(--space-m);
		font-weight: 600;
		text-decoration: none;
	}
	.crisis__btn:hover {
		background: var(--color-accent-muted);
		border-color: var(--color-accent-muted);
	}
	.crisis__btn--ghost {
		background: transparent;
		color: var(--color-accent);
	}
	.crisis__btn--ghost:hover {
		background: transparent;
		color: var(--color-fg);
		border-color: var(--color-fg);
	}
	.crisis__danger {
		font-size: var(--font-size-s);
		color: var(--color-fg-muted);
		margin: var(--space-m) 0 0;
	}
	.crisis__danger a {
		color: var(--color-accent);
	}
	.crisis__note {
		font-size: var(--font-size-xs, 12px);
		color: var(--color-fg-muted);
		margin: var(--space-s) 0 0;
	}
</style>
