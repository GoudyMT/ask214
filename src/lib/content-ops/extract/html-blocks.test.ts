import { describe, it, expect } from 'vitest';
import { shapeHtmlBlocks } from './html-blocks';

describe('shapeHtmlBlocks', () => {
	it('tracks the heading as the section for it and the blocks under it', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'h2', text: 'Eligibility' },
			{ tag: 'p', text: 'You may qualify if you served.' },
			{ tag: 'p', text: 'Apply online or by mail.' }
		]);
		expect(r.blocks).toEqual([
			{ text: 'Eligibility', section: 'Eligibility' },
			{ text: 'You may qualify if you served.', section: 'Eligibility' },
			{ text: 'Apply online or by mail.', section: 'Eligibility' }
		]);
	});

	it('switches section at the next heading', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'h2', text: 'How to file' },
			{ tag: 'p', text: 'Submit the form.' },
			{ tag: 'h3', text: 'Deadlines' },
			{ tag: 'p', text: 'Within one year.' }
		]);
		expect(r.blocks.map((b) => b.section)).toEqual([
			'How to file',
			'How to file',
			'Deadlines',
			'Deadlines'
		]);
	});

	it('emits blocks before any heading with no section key', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'p', text: 'Intro paragraph.' },
			{ tag: 'h2', text: 'Section one' }
		]);
		expect(r.blocks[0]).toEqual({ text: 'Intro paragraph.' });
		expect(r.blocks[1]).toEqual({ text: 'Section one', section: 'Section one' });
	});

	it('normalizes each block text and builds normalizedText as the flat join', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'p', text: 'spaced   out\ntext' },
			{ tag: 'p', text: 'second' }
		]);
		expect(r.blocks[0]?.text).toBe('spaced out text');
		expect(r.normalizedText).toBe('spaced out text second');
	});

	it('keeps adjacent blocks separated in normalizedText (no run-together fusion)', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'p', text: 'benefits.' },
			{ tag: 'p', text: 'Sign in with a verified account' }
		]);
		expect(r.normalizedText).toBe('benefits. Sign in with a verified account');
	});

	it('skips blocks that normalize to empty', () => {
		const r = shapeHtmlBlocks([
			{ tag: 'p', text: '   ' },
			{ tag: 'p', text: 'real' }
		]);
		expect(r.blocks).toEqual([{ text: 'real' }]);
	});

	it('sets html mode + textLayerPresent and handles an empty sequence', () => {
		expect(shapeHtmlBlocks([])).toEqual({
			normalizedText: '',
			blocks: [],
			textLayerPresent: true,
			extractionMode: 'html'
		});
	});
});
