// Stands in for the workerd-only `cloudflare:workers` module in the server test project (vite.config.ts). The
// Cloudflare adapter answers that import with an external module, which vi.mock cannot replace; resolved to this file
// instead, each test that needs the module mocks it with the bindings or classes it tests against.
export const env: Record<string, unknown> = {};
export class DurableObject {}
