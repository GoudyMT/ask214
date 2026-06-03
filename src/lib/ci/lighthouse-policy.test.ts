import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI invariant (P2): Lighthouse reports are written to the local filesystem, never uploaded to
// a third-party public URL. `temporary-public-storage` posts reports to a Google-hosted public
// link - misaligned with the project's privacy-first, no-third-party stance. The `assert` block
// in lighthouserc.json remains the quality gate; this test locks WHERE the reports go so the
// target cannot silently regress. Mirrors the Q1 pii-policy / P1b headers-policy CI-invariant
// tests (same process.cwd() file-read convention).

describe('lighthouserc upload policy (P2)', () => {
	const config = JSON.parse(readFileSync(join(process.cwd(), 'lighthouserc.json'), 'utf8'));
	const upload = config.ci?.upload;

	it('uploads Lighthouse reports to the local filesystem, not third-party public storage', () => {
		expect(upload?.target).toBe('filesystem');
		expect(upload?.target).not.toBe('temporary-public-storage');
	});

	it('sets an explicit outputDir so reports are not dumped into the repo root', () => {
		// Verified against @lhci/cli upload.js (runFilesystemTarget): an empty/omitted outputDir
		// resolves to cwd (repo root). A dedicated dir keeps reports contained (and gitignored).
		expect(typeof upload?.outputDir).toBe('string');
		expect(upload?.outputDir).not.toBe('');
	});
});
