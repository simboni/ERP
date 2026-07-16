/**
 * Authoritative server-side lists for the industry switchboard. The web app
 * carries its own richer copies (labels, emoji, presets) in apps/web/lib/
 * modules.ts, but validation must never trust the client — these are the
 * canonical key sets the API accepts.
 */

/** The 8 known business types. */
export const BUSINESS_TYPE_KEYS = [
  "general",
  "retail",
  "restaurant",
  "hotel",
  "salon",
  "manufacturing",
  "auto",
  "services",
] as const;

/** The 7 OPTIONAL (toggleable) module keys. Core modules are never listed. */
export const OPTIONAL_MODULE_KEYS = [
  "pos",
  "quotes",
  "crm",
  "projects",
  "documents",
  "finance",
  "controls",
] as const;

export function isBusinessType(v: unknown): v is string {
  return typeof v === "string" && (BUSINESS_TYPE_KEYS as readonly string[]).includes(v);
}

export function isOptionalModuleKey(v: unknown): v is string {
  return typeof v === "string" && (OPTIONAL_MODULE_KEYS as readonly string[]).includes(v);
}
