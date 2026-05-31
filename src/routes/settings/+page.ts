// PII route: client-only. Reads + edits decrypted profile fields (browser-only store), so
// never server-rendered or prerendered (L2 per-route ssr=false lock).
export const ssr = false;
export const prerender = false;
