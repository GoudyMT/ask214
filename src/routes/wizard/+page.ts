// PII route: client-only. The profile store + its decrypted state are browser-only, so the
// wizard is never server-rendered or prerendered (L2 per-route ssr=false lock; no PII in any
// build-time or edge-rendered HTML).
export const ssr = false;
export const prerender = false;
