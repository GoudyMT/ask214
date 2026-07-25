import type { CleanReport } from '$lib/content-ops/clean/clean-extraction';

export type SourceReview = { sourceId: string; report: CleanReport };

/** Minimal HTML entity escape -- the corpus text is untrusted-shaped, so every interpolated string
 *  passes through this before landing in the page. Covers the five characters that can break out of
 *  text or an attribute context. */
function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderSource({ sourceId, report }: SourceReview): string {
	const head = `<h2>${esc(sourceId)} <span class="counts">(${report.dropped.length} dropped / ${report.stripped.length} stripped / ${report.review.length} review)</span></h2>`;
	const dropped = report.dropped.length
		? `<h3>Dropped</h3>` +
			report.dropped
				.map(
					(d) =>
						`<div class="dropped">${d.page !== undefined ? `<span class="pg">page ${d.page}</span> ` : ''}<span class="kind">[${esc(d.kind)}]</span> ${esc(d.preview)}</div>`
				)
				.join('')
		: '';
	const stripped = report.stripped.length
		? `<h3>Stripped</h3>` +
			report.stripped
				.map(
					(s) =>
						`<div class="strip">${s.page !== undefined ? `<span class="pg">page ${s.page}</span>` : ''}<div class="before"><span class="lbl">before</span> ${esc(s.before)}</div><div class="after"><span class="lbl">after</span> ${esc(s.after)}</div></div>`
				)
				.join('')
		: '';
	return `<section>${head}${dropped}${stripped}</section>`;
}

/**
 * Builds a self-contained HTML review of a clean run: one section per source that changed, showing
 * every dropped block and every before->after strip with the removed content highlighted. Inline
 * styles only -- it opens from disk without a server. Callers pass only sources with a non-empty
 * report (the unchanged ones are summarized in the trailing line).
 */
export function buildReviewHtml(sources: SourceReview[]): string {
	const body = sources.map(renderSource).join('\n');
	const style = [
		'body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#111}',
		'h2{margin-top:2rem;border-bottom:1px solid #ccc}',
		'.counts{font-weight:400;color:#666}',
		'.strip{margin:.5rem 0;padding:.5rem;background:#f6f6f6;border-radius:4px}',
		'.before{color:#a00}.after{color:#060}',
		'.lbl{display:inline-block;width:3.5rem;font-weight:600;color:#666}',
		'.dropped{margin:.25rem 0;color:#a00}',
		'.pg,.kind{color:#666}'
	].join('');
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Corpus clean review</title><style>${style}</style></head>
<body>
<h1>Corpus clean review</h1>
<p>${sources.length} sources with changes to review.</p>
${body}
</body></html>`;
}
