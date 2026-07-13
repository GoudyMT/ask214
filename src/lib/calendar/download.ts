/** Trigger a browser download of a text blob - fully client-side, no network. */
export function downloadTextFile(filename: string, mime: string, content: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
