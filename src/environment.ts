// Sentry-style environment tags, validated the same way the ingest server does
// (kept in sync by hand — the SDK has no shared dependency on the backend):
//   - trimmed; empty is treated as "not provided"
//   - max 64 chars
//   - no whitespace (incl. newlines) or forward slashes
//   - not the literal "none" (case-insensitive)
// Case is otherwise preserved (environments are case-sensitive).

const MAX_LEN = 64;
const INVALID = /[\s/]/;

/** Returns the cleaned environment, or undefined if absent/invalid (the caller
 *  falls back to its default, and ultimately the server defaults to "production"). */
export function cleanEnvironment(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v || v.length > MAX_LEN || INVALID.test(v) || v.toLowerCase() === "none") return undefined;
  return v;
}
