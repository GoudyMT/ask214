<script lang="ts">
	import FeedbackForm from '#lib/components/FeedbackForm.svelte';
	import { readStashedRoute } from '#lib/feedback/context.js';
	import type { FeedbackInput } from '#lib/feedback/types.js';

	const attachedRoute = readStashedRoute();
	// A send that opens and then hears nothing is given up here and shows the failure line; the server's own bound
	// on its mail call is shorter, so a slow mail service reads as the server's answer first.
	const FEEDBACK_SEND_MS = 20_000;

	async function submit(input: FeedbackInput): Promise<{ ok: boolean }> {
		try {
			const res = await fetch('/api/feedback', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(FEEDBACK_SEND_MS)
			});
			return { ok: res.ok };
		} catch {
			return { ok: false };
		}
	}
</script>

<svelte:head>
	<title>Feedback - Ask 214</title>
</svelte:head>

<h1>Send feedback</h1>
<p>
	Found something wrong, or have an idea to make this better? Send it my way - it goes straight to
	my inbox.
</p>

<FeedbackForm {attachedRoute} {submit} />
