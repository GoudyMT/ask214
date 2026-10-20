/**
 * Whether a string has the shape of an Anthropic API key. A backup passphrase or any other text pasted into the
 * key field must never be stored or sent as the key, so the shape is checked before either happens.
 */
export function isAnthropicKeyShape(s: string): boolean {
	return s.startsWith('sk-ant-') && !/\s/.test(s);
}
