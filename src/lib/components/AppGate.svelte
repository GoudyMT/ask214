<script lang="ts">
	import type { Snippet } from 'svelte';
	import UnsupportedBrowser from './UnsupportedBrowser.svelte';
	import type { ProfileApp } from '../profile/context';

	type Props = { app: ProfileApp; children: Snippet };
	let { app, children }: Props = $props();
</script>

<!--
  App-init gate. Only the `unsupported` capability failure is a full-takeover
  (the hard-stop). `loading` and `ready` both render the app shell - the shell is NOT
  gated behind store-readiness, so static content stays server-renderable (keep-prerender);
  store-dependent UI (banner/CTA) renders nothing until the store is ready (sub-second pop-in).
-->
{#if app.status === 'unsupported' && app.cause}
	<UnsupportedBrowser cause={app.cause} />
{:else}
	{@render children()}
{/if}
