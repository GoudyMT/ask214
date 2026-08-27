<script lang="ts">
	import SourceList from '$lib/components/SourceList.svelte';
	import { SOURCES_INDEX } from '$lib/sources/sources-index.data';
</script>

<svelte:head>
	<title>About - Ask 214</title>
	<meta name="description" content="Mission and privacy stance for the Ask 214 project." />
</svelte:head>

<h1>About</h1>

<h2>What this is</h2>
<p>
	A privacy-first companion that helps US transitioning service members navigate the ~24-month
	period before and after separation. Ask a question and get answers backed by official sources, or
	build a timeline of what to do and when. Built by a US Navy veteran. Free, donation-supported, no
	ads ever.
</p>

<h2>What this is not</h2>
<p>
	This project is independent and NOT affiliated with the US Department of Defense, the Department
	of Veterans Affairs, or any branch of the US military. We do not provide legal, financial, or
	medical advice. We do not assist with VA claims or charge for claims-related services. For
	official benefits guidance, contact a VA-accredited Veteran Service Organization or visit va.gov.
</p>

<h2>Privacy</h2>
<p>
	Your personal information stays on your device by default. We do not use third-party trackers,
	advertising IDs, fingerprinting, or analytics of any kind.
</p>

<h2>Sources</h2>
<p>
	Every answer is drawn from public US Government work (17 USC section 105) and cites the exact
	source it uses. Below is every source held in the app, each linked to its original.
</p>

<SourceList index={SOURCES_INDEX} />
