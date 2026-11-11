import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { headersFor, parseHeadersFile } from './headers-policy.ts';

/**
 * Send the `_headers` rules from the preview server, as Cloudflare does for the static files it serves.
 *
 * The preview's own static server sends none of them, and a worker takes its content security policy from its own
 * script's response, so without this the E2E suite runs every worker with no policy and cannot see one go missing.
 * Only a file path (its last segment names an extension) gets them: in production a rendered page takes them from
 * the server hook, never from `_headers`, so the E2E tests of rendered pages must reach the hook, not this plugin.
 *
 * @param file The `_headers` file to read, once, when the preview server starts.
 * @returns A Vite plugin that applies only to `vite preview`.
 */
export function previewHeaders(file: string): Plugin {
	return {
		name: 'preview-headers',
		configurePreviewServer(server) {
			const rules = parseHeadersFile(readFileSync(file, 'utf8'));
			// Added here, not in a returned hook, so it runs before the static server can answer.
			server.middlewares.use((req, res, next) => {
				const pathname = new URL(req.url ?? '/', 'https://preview.invalid').pathname;
				if (!pathname.split('/').pop()?.includes('.')) return next();
				for (const [name, value] of Object.entries(headersFor(rules, pathname))) {
					res.setHeader(name, value);
				}
				next();
			});
		}
	};
}
