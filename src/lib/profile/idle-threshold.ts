// Auto-lock the in-memory profile after 15 minutes of no user input (memory hygiene;
// unlock is a transparent local-key re-decrypt in v1.0).
export const IDLE_THRESHOLD_MS = 15 * 60 * 1000;
