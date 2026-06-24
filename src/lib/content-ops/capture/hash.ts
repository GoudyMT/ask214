/** sha256 of raw bytes as lowercase hex. Web Crypto (portable: Node 22 + browsers). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh ArrayBuffer-backed view: digest's BufferSource excludes SharedArrayBuffer-backed
	// arrays, and a general Uint8Array param is ArrayBufferLike (this also lets a Node Buffer in from A2's script).
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
