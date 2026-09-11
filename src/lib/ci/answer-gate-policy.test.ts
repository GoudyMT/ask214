import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// CI invariant: the answer quality gate must actually RUN. It was written to be CI-safe and then wired
// into nothing, so the feature's every quality claim rested on someone remembering to run a script by
// hand - which is the failure the project's own rule names, "the gate is what CI runs, never the subset
// I picked". This test locks the wiring so removing the step fails a test instead of passing silently.
//
// Only the on-device gate is pinned here. The online one needs a live Workers AI binding and cannot run
// in CI at all; the two share the selector, the measurement module and the decision function, so the
// device run covers everything except the online path's own embedder and floors.
// Mirrors the sources-index / sast / lighthouse policy tests.
describe('answer quality gate policy', () => {
	const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
	const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
	const steps = workflow.jobs?.test?.steps ?? [];
	const gateStep = steps.find(
		(s: { run?: string }) => typeof s.run === 'string' && /\banswer-gate\b/.test(s.run)
	);

	it('defines both gate scripts', () => {
		expect(pkg.scripts['answer-gate']).toContain('content-ops/answer-gate.mjs');
		expect(pkg.scripts['answer-gate:bge']).toContain('content-ops/answer-gate-bge.mjs');
	});

	it('runs the on-device gate in CI', () => {
		expect(gateStep).toBeDefined();
	});

	// It must be the DEVICE gate, not the online one: `answer-gate:bge` would fail in CI for want of a
	// Workers AI binding, and a step that cannot pass would be disabled rather than fixed.
	it('wires the device gate, not the online one', () => {
		expect(gateStep?.run).not.toContain('answer-gate:bge');
	});

	// The gate is only CI-safe because it reads committed artifacts. If any of these stopped being
	// tracked, the step would fail in CI for a reason that has nothing to do with answer quality.
	it('depends only on artifacts committed to the repo', () => {
		for (const path of [
			'static/corpus/corpus-v1.0.1.json',
			'static/corpus/corpus-v1.0.1.embeddings.bin',
			'static/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'src/lib/ask/eval/queries.json'
		]) {
			expect(() => readFileSync(join(process.cwd(), path)), path).not.toThrow();
		}
	});

	// The device gate must read the SAME weights the browser serves. Resolving from the model hub would
	// score a copy no user runs, and would not notice the swap the model-integrity test exists to catch.
	it('pins the on-device gate to the vendored weights, with no remote fallback', () => {
		const gate = readFileSync(join(process.cwd(), 'content-ops/answer-gate.mjs'), 'utf8');
		expect(gate).toContain('env.allowRemoteModels = false');
		expect(gate).toContain('env.localModelPath = LOCAL_MODEL_PATH');
		expect(gate).toContain("const LOCAL_MODEL_PATH = 'static/models/'");
	});
});
