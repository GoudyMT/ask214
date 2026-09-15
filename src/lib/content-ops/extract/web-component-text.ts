/** One element's attributes keyed by name. HTML parsers lowercase attribute names, so the keys are too. */
export type ElementAttributes = Record<string, string>;

/**
 * The visible text a web component renders from its attributes alone, or null when `tag` is not such a
 * component (or its content attribute is absent) - the caller then walks the element's children as usual.
 *
 * VA.gov markup carries some content ONLY in attributes: `<va-telephone contact="855-260-3274">` has no
 * child text node, so a plain text-node walk drops the number and leaves "call us at ." behind. Mapping the
 * element to its rendered text lets the walk substitute that text at the element's position. Pure.
 */
export function webComponentText(tag: string, attributes: ElementAttributes): string | null {
	if (tag.toLowerCase() !== 'va-telephone') return null;
	const contact = (attributes.contact ?? '').trim();
	if (contact.length === 0) return null;
	// va.gov writes an extension as "202-123-1234, ext. 9". A bare `extension` attribute parses to an empty
	// string, so the separator is emitted only for a real extension - never as a dangling ", ext.".
	const extension = (attributes.extension ?? '').trim();
	return extension.length === 0 ? contact : `${contact}, ext. ${extension}`;
}
