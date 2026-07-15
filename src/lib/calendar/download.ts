/**
 * Outlive the browser's download handoff before freeing the blob. Matches the long-standing value in
 * FileSaver.js, chosen there because shorter deferrals proved unreliable across browsers. The URL is
 * same-origin and unguessable, so holding it briefly costs nothing.
 */
const REVOKE_DELAY_MS = 40_000;

/** Trigger a browser download of a text blob - fully client-side, no network. */
export function downloadTextFile(filename: string, mime: string, content: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoking on the click's own tick pulls the blob out from under a download that has not read it
	// yet: Chromium tolerates it, Firefox and WebKit drop the file silently. Defer, but still revoke -
	// an object URL left alive pins the user's deadlines in memory for the document's lifetime.
	setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
