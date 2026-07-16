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

/**
 * business_type → OPTIONAL modules that start ON. Kept IDENTICAL to the
 * PRESETS map in apps/web/lib/modules.ts so the server is authoritative:
 * demo (and any server-driven) provisioning never trusts the client for
 * which modules a workspace opens with. "general" turns everything on.
 */
export const PRESET_MODULES: Record<string, string[]> = {
  general: ["pos", "quotes", "crm", "projects", "documents", "finance", "controls"],
  retail: ["pos", "documents"],
  restaurant: ["pos", "documents"],
  hotel: ["pos", "crm", "projects", "documents", "finance"],
  salon: ["pos", "crm", "documents"],
  manufacturing: ["quotes", "projects", "finance", "controls", "documents"],
  auto: ["pos", "quotes", "crm", "projects", "finance", "documents"],
  services: ["quotes", "crm", "projects", "finance", "documents"],
};

/** Optional modules a business type starts with (falls back to "general"). */
export function presetModules(type: string): string[] {
  return PRESET_MODULES[type] ?? PRESET_MODULES.general;
}

/** Human label for a business type, used to name demo workspaces. */
export const BUSINESS_TYPE_LABELS: Record<string, string> = {
  general: "Business",
  retail: "Shop",
  restaurant: "Restaurant",
  hotel: "Hotel",
  salon: "Salon",
  manufacturing: "Factory",
  auto: "Garage",
  services: "Services",
};

export function isBusinessType(v: unknown): v is string {
  return typeof v === "string" && (BUSINESS_TYPE_KEYS as readonly string[]).includes(v);
}

export function isOptionalModuleKey(v: unknown): v is string {
  return typeof v === "string" && (OPTIONAL_MODULE_KEYS as readonly string[]).includes(v);
}
