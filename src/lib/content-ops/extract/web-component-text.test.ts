import { describe, it, expect } from 'vitest';
import { webComponentText } from './web-component-text';

describe('webComponentText', () => {
	it('renders a va-telephone contact number as the element text', () => {
		expect(webComponentText('va-telephone', { contact: '855-260-3274', extension: '' })).toBe(
			'855-260-3274'
		);
	});

	it('emits no extension separator when the extension attribute is empty', () => {
		// A bare `extension` attribute parses to '' just like extension="", and whitespace is not a value.
		expect(webComponentText('va-telephone', { contact: '800-827-1000', extension: '' })).toBe(
			'800-827-1000'
		);
		expect(webComponentText('va-telephone', { contact: '800-827-1000' })).toBe('800-827-1000');
		expect(webComponentText('va-telephone', { contact: '800-827-1000', extension: '  ' })).toBe(
			'800-827-1000'
		);
	});

	it('appends a non-empty extension in the published va.gov form', () => {
		expect(webComponentText('va-telephone', { contact: '202-123-1234', extension: '9' })).toBe(
			'202-123-1234, ext. 9'
		);
	});

	it('trims surrounding whitespace out of both attribute values', () => {
		expect(webComponentText('va-telephone', { contact: ' 711 ', extension: ' 42 ' })).toBe(
			'711, ext. 42'
		);
	});

	it('matches the tag case-insensitively so a raw DOM tagName still resolves', () => {
		expect(webComponentText('VA-TELEPHONE', { contact: '866-279-3677' })).toBe('866-279-3677');
	});

	it('returns null for ordinary markup so the caller walks its children as usual', () => {
		expect(webComponentText('p', {})).toBeNull();
		expect(webComponentText('a', { href: '/health-care', text: 'Health care' })).toBeNull();
		expect(webComponentText('li', {})).toBeNull();
		expect(webComponentText('span', { class: 'vads-u-font-weight--bold' })).toBeNull();
	});

	it('returns null for a va-telephone with no usable contact', () => {
		expect(webComponentText('va-telephone', {})).toBeNull();
		expect(webComponentText('va-telephone', { contact: '   ' })).toBeNull();
	});
});
