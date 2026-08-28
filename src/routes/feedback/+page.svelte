<script lang="ts">
	import FeedbackForm from '$lib/components/FeedbackForm.svelte';
	import { readStashedRoute } from '$lib/feedback/context';
	import type { FeedbackInput } from '$lib/feedback/types';

	const attachedRoute = readStashedRoute();

	async function submit(input: FeedbackInput): Promise<{ ok: boolean }> {
		try {
			const res = await fetch('/api/feedback', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
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
