import { describe, it, expect } from 'vitest';
import { classifyAsset } from './asset-cache';

// classifyAsset decides how the service worker caches a same-origin static asset. The heavy on-device
// model + ORT WASM (~34MB) are LAZY (cached on first use, never eagerly precached at install); the app
// shell + the tiny corpus are PRECACHE (eager, so the app works offline immediately). See ADR-015 / spec 9.
describe('classifyAsset', () => {
	it('marks the heavy model + ORT WASM as lazy (kept out of the install precache)', () => {
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')).toBe('lazy');
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/config.json')).toBe('lazy');
		expect(classifyAsset('/wasm/ort-wasm-simd-threaded.wasm')).toBe('lazy');
	});

	it('marks the app shell + tiny corpus + icons as precache', () => {
		expect(classifyAsset('/_app/immutable/entry/start.js')).toBe('precache');
		expect(classifyAsset('/corpus/corpus-v1.0.json')).toBe('precache');
		expect(classifyAsset('/corpus/corpus-v1.0.embeddings.bin')).toBe('precache');
		expect(classifyAsset('/favicon.png')).toBe('precache');
	});
});
