import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Forced colors (Windows high contrast) repaint every fill from a small system palette and keep only borders and
// text, so a filled button with no border shows as bare text that no one can tell is a button. Every filled
// accent control therefore carries a border, transparent outside forced colors, which the browser repaints in a
// system colour. Gate the whole class so a new filled button cannot ship without one.
const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

const FILL = 'background: var(--color-accent)';
const LABEL = 'color: var(--color-bg)';
// A pressed pill sits inside a bordered group that marks the choice its own way, and a hover fill paints a control
// that already has its resting look; neither is a resting filled button.
const NOT_RESTING = [':hover', '[aria-pressed'];
const NEWLINE = String.fromCharCode(10);

function styleSources(): string[] {
	const svelte = readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.svelte'))
		.map((entry) => join(entry.parentPath, entry.name));
	return [...svelte, join(SRC_DIR, 'app.css')];
}

function stripComments(css: string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const open = css.indexOf('/*', at);
		if (open === -1) return out + css.slice(at);
		out += css.slice(at, open);
		const close = css.indexOf('*/', open + 2);
		if (close === -1) return out;
		at = close + 2;
	}
}

function cssOf(file: string): string {
	const text = readFileSync(file, 'utf8');
	if (file.endsWith('.css')) return stripComments(text);
	const open = text.indexOf('<style>');
	const close = text.indexOf('</style>');
	return open === -1 || close === -1
		? ''
		: stripComments(text.slice(open + '<style>'.length, close));
}

interface Rule {
	selector: string;
	declarations: string[];
}

// Rules are read flat: the text before a block's last `{` back to the previous `{` is its selector, so a rule
// inside a media query keeps its own selector.
function rulesOf(css: string): Rule[] {
	const rules: Rule[] = [];
	for (const chunk of css.split('}')) {
		const brace = chunk.lastIndexOf('{');
		if (brace === -1) continue;
		const before = chunk.slice(0, brace);
		const selector = before.slice(before.lastIndexOf('{') + 1).trim();
		const declarations = chunk
			.slice(brace + 1)
			.split(';')
			.map((d) => d.trim().split(NEWLINE).join(' '))
			.filter((d) => d.length > 0);
		rules.push({ selector, declarations });
	}
	return rules;
}

function filledButtons(css: string): Rule[] {
	return rulesOf(css).filter(
		(rule) =>
			rule.declarations.includes(FILL) &&
			rule.declarations.includes(LABEL) &&
			!NOT_RESTING.some((mark) => rule.selector.includes(mark))
	);
}

function hasEdge(rule: Rule): boolean {
	const border = rule.declarations.filter((d) => d.startsWith('border:'));
	const last = border[border.length - 1];
	return last !== undefined && last.includes('solid') && last.includes('1px');
}

describe('reading the style rules', () => {
	it('finds a filled rule inside a media query, and skips its hover and pressed fills', () => {
		const css = stripComments(
			'@media (min-width: 1px) { .a { background: var(--color-accent); color: var(--color-bg); border: none; } }' +
				' .a:hover { background: var(--color-accent); color: var(--color-bg); }' +
				' .b[aria-pressed="true"] { background: var(--color-accent); color: var(--color-bg); }' +
				' /* .c { background: var(--color-accent); color: var(--color-bg); } */'
		);
		expect(filledButtons(css).map((r) => r.selector)).toEqual(['.a']);
	});

	it('tells an edge from none, and reads the last border declared', () => {
		const rule = (border: string): Rule => ({
			selector: '.a',
			declarations: [FILL, LABEL, border]
		});
		expect(hasEdge(rule('border: 1px solid transparent'))).toBe(true);
		expect(hasEdge(rule('border: none'))).toBe(false);
		expect(
			hasEdge({
				selector: '.a',
				declarations: [FILL, LABEL, 'border: 1px solid transparent', 'border: none']
			})
		).toBe(false);
	});
});

describe('every filled accent control keeps an edge under forced colors', () => {
	const found: string[] = [];
	for (const file of styleSources()) {
		const rel = relative(SRC_DIR, file).split(sep).join('/');
		for (const rule of filledButtons(cssOf(file))) {
			found.push(rel);
			it(`${rel} ${rule.selector} has a 1px solid border`, () => {
				expect(hasEdge(rule), `${rel} ${rule.selector}: ${rule.declarations.join('; ')}`).toBe(
					true
				);
			});
		}
	}

	// The scan itself must see the buttons it guards: a parser that read nothing would pass every file.
	it('reads the filled buttons it guards', () => {
		expect(found).toContain('routes/wizard/+page.svelte');
		expect(found).toContain('lib/backup/BackupCard.svelte');
	});
});
