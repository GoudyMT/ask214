/**
 * Where the vendored library and its worker are served from: their own namespace, which the service worker
 * treats as lazy, in a folder named for the release. pdf.js refuses to run against a worker from another
 * release, and a cached file at a fixed URL is served forever - so a new release gets a new folder, and a
 * returning user can never be handed a new library with an old cached worker. `pnpm check:pdf-worker` fails
 * when the folder, the files and the installed package disagree.
 *
 * The paths live apart from the loader because saving a document stores the library with it: a page that
 * saves needs the paths, and must not ship the loader for them.
 */
const PDF_DIR = '/pdf-worker/6.3.289/';
export const LIBRARY_SRC = `${PDF_DIR}pdf.min.mjs`;
export const WORKER_SRC = `${PDF_DIR}pdf.worker.min.mjs`;
// The two files' size together, which a first save states it downloads. A test holds it to the files on disk,
// so a new release fails until it is stated again.
export const LIBRARY_BYTES = 1_724_118;
