import { MAX_FILE_BYTES } from '../contract/listing';

/**
 * The body of a response, read at most `maxBytes` deep. The size is enforced on the bytes that actually arrive:
 * a Content-Length header only lets a too-large file be refused sooner, since a server can understate it or
 * stream without end.
 */
export async function readCapped(
	response: Response,
	maxBytes: number = MAX_FILE_BYTES
): Promise<Uint8Array> {
	const body = response.body;
	if (body === null) throw new Error('E_SBF_NO_BODY');

	const declared = Number(response.headers.get('content-length'));
	if (declared > maxBytes) {
		await body.cancel().catch(() => undefined);
		throw new Error('E_SBF_TOO_LARGE');
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error('E_SBF_TOO_LARGE');
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
