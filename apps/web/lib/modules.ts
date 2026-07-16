/**
 * Industry foundation — the ONE place industry knowledge lives.
 *
 * The app is tailored per business type through a switchboard, never through
 * per-industry branching. Two tenant fields drive everything:
 *   - business_type: one of BUSINESS_TYPES below (a label + a starting preset)
 *   - enabled_modules: which OPTIONAL modules are visible for this tenant
 *
 * CORE modules (dashboard, invoices, payments, customers, purchasing,
 * suppliers, inventory, hr, payroll, reports, vat, settings) are always
 * visible and never appear here — they are not toggleable.
 *
 * The rest of the system reads enabled_modules only; it never inspects
 * business_type in logic. The PRESETS map below is the sole exception: it
 * translates a business type into a sensible starting set of optional modules,
 * which the tenant can then fine-tune module-by-module.
 */

/** The 7 OPTIONAL (toggleable) module keys. */
export const OPTIONAL_MODULE_KEYS = [
  "pos",
  "quotes",
  "crm",
  "projects",
  "documents",
  "finance",
  "controls",
] as const;

export type OptionalModuleKey = (typeof OPTIONAL_MODULE_KEYS)[number];

/** Business types offered at onboarding and in Settings, in display order. */
export interface BusinessType {
  key: string;
  label: string;
  emoji: string;
  blurb: string;
}

export const BUSINESS_TYPES: BusinessType[] = [
  {
    key: "retail",
    label: "Retail / Shop",
    emoji: "🛒",
    blurb: "Sell over the counter with a till and stock.",
  },
  {
    key: "restaurant",
    label: "Restaurant / Bar",
    emoji: "🍽️",
    blurb: "Table and counter service, food and drink.",
  },
  {
    key: "hotel",
    label: "Hotel / Resort",
    emoji: "🏨",
    blurb: "Rooms, bookings and guest services.",
  },
  {
    key: "salon",
    label: "Salon / Spa",
    emoji: "💇",
    blurb: "Appointments and personal-care services.",
  },
  {
    key: "manufacturing",
    label: "Manufacturing",
    emoji: "🏭",
    blurb: "Make goods to order with jobs and controls.",
  },
  {
    key: "auto",
    label: "Auto dealer / Garage",
    emoji: "🚗",
    blurb: "Vehicle sales, parts and repair jobs.",
  },
  {
    key: "services",
    label: "Professional services",
    emoji: "💼",
    blurb: "Bill projects and retainers by quote.",
  },
  {
    key: "general",
    label: "General / Other",
    emoji: "🏢",
    blurb: "Everything on — a good place to start.",
  },
];

/** The valid business-type keys (authoritative on the client). */
export const BUSINESS_TYPE_KEYS = BUSINESS_TYPES.map((b) => b.key);

/** Metadata for the optional-module toggle matrix in Settings. */
export interface OptionalModule {
  key: OptionalModuleKey;
  label: string;
  description: string;
}

export const OPTIONAL_MODULES: OptionalModule[] = [
  {
    key: "pos",
    label: "Point of sale",
    description: "A fast till for over-the-counter sales.",
  },
  {
    key: "quotes",
    label: "Quotes",
    description: "Send estimates that convert into invoices.",
  },
  {
    key: "crm",
    label: "CRM",
    description: "Track leads and the sales pipeline.",
  },
  {
    key: "projects",
    label: "Projects",
    description: "Run jobs with tasks, time and billing.",
  },
  {
    key: "documents",
    label: "Documents",
    description: "Store and share files with customers.",
  },
  {
    key: "finance",
    label: "Finance",
    description: "Deeper ledgers, budgets and cash flow.",
  },
  {
    key: "controls",
    label: "Controls",
    description: "Approvals and business-control checks.",
  },
];

/**
 * business_type → which OPTIONAL modules start ON. This map is the ONLY
 * industry-aware logic in the whole system. "general" turns everything on.
 */
export const PRESETS: Record<string, OptionalModuleKey[]> = {
  general: ["pos", "quotes", "crm", "projects", "documents", "finance", "controls"],
  retail: ["pos", "documents"],
  restaurant: ["pos", "documents"],
  hotel: ["pos", "crm", "projects", "documents", "finance"],
  salon: ["pos", "crm", "documents"],
  manufacturing: ["quotes", "projects", "finance", "controls", "documents"],
  auto: ["pos", "quotes", "crm", "projects", "finance", "documents"],
  services: ["quotes", "crm", "projects", "finance", "documents"],
};

/** The optional modules a business type starts with (falls back to general). */
export function presetModules(type: string): OptionalModuleKey[] {
  return PRESETS[type] ?? PRESETS.general;
}

/**
 * Role → the set of sidebar hrefs that role may see. This is a SECOND filter
 * dimension on top of the tenant's enabled_modules: a nav item renders only
 * when it clears BOTH gates. Owner and admin are special-cased to "all" (they
 * see every enabled module) and never appear here. /dashboard is always
 * allowed for every role; /settings is owner/admin only.
 *
 * This mirrors the API @Roles(...) guards — it is UX + defense-in-depth, never
 * the security boundary. Keep it aligned with the guards, do not weaken them.
 */
export const ROLE_NAV: Record<string, string[]> = {
  accountant: [
    "/dashboard",
    "/quotes",
    "/invoices",
    "/payments",
    "/customers",
    "/purchases",
    "/suppliers",
    "/inventory",
    "/projects",
    "/finance",
    "/reports",
    "/vat",
    "/documents",
  ],
  cashier: ["/dashboard", "/pos", "/invoices", "/payments", "/customers", "/quotes"],
  storekeeper: ["/dashboard", "/inventory", "/purchases", "/suppliers"],
  payroll: ["/dashboard", "/payroll", "/hr"],
  hr: ["/dashboard", "/hr"],
  viewer: ["/dashboard", "/reports"],
};

/**
 * Whether a role may see a given sidebar href. Owner/admin see everything;
 * /dashboard is always allowed; /settings is owner/admin only; otherwise the
 * href must be in that role's ROLE_NAV set. Unknown roles fall through to a
 * dashboard-only view.
 */
export function roleCanSee(role: string | null | undefined, href: string): boolean {
  if (role === "owner" || role === "admin") return true;
  if (href === "/dashboard") return true;
  if (href === "/settings") return false;
  if (!role) return false;
  return (ROLE_NAV[role] ?? []).includes(href);
}
