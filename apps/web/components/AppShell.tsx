"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, clearTokens, getTenantToken } from "@/lib/api";
import { CommandPalette } from "@/components/CommandPalette";
import { LangToggle, useI18n, type TKey } from "@/lib/i18n";
import { OPTIONAL_MODULE_KEYS, type OptionalModuleKey } from "@/lib/modules";

/* Minimal 16px stroke icon set (inline, no dependencies). */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
export const Icons = {
  home: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  ),
  quote: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h7M9 17h5" />
    </svg>
  ),
  invoice: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  payment: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  people: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
      <path d="M15.5 5.8a3.2 3.2 0 0 1 0 5.4M17.7 14.9c1.6.7 2.8 2 3.3 4.1" />
    </svg>
  ),
  cart: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 4h2.5l2.2 11h10.8l2-8H7" />
      <circle cx="10" cy="19.5" r="1.4" />
      <circle cx="17" cy="19.5" r="1.4" />
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M2 6h12v10H2zM14 10h4.5L21 13v3h-7" />
      <circle cx="6.5" cy="17.5" r="1.6" />
      <circle cx="16.5" cy="17.5" r="1.6" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </svg>
  ),
  payroll: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M12 11v5M9.8 12.5h4.4" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6z" />
      <path d="m9 11.5 2 2 4-4.5" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8.5 16v-5M13 16V8M17.5 16v-3" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 5 5" />
    </svg>
  ),
  till: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M4 10h16l-1.5 10h-13z" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M9.5 14h5" />
    </svg>
  ),
  funnel: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 4h18l-7 8.5V20l-4-2v-5.5z" />
    </svg>
  ),
  coins: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2.5 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  briefcase: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13.5h18" />
    </svg>
  ),
  scale: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M12 4v16M7 20h10" />
      <path d="M12 6 5 8m7-2 7 2" />
      <path d="M2.5 14a2.7 2.7 0 0 0 5 0L5 8zM16.5 14a2.7 2.7 0 0 0 5 0L19 8z" />
    </svg>
  ),
  signout: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M14 4H6v16h8" />
      <path d="M17 8.5 20.5 12 17 15.5M10 12h10.5" />
    </svg>
  ),
};

interface NavItem {
  href: string;
  labelKey: TKey;
  icon: keyof typeof Icons;
  // Optional (toggleable) modules carry their key; core items omit it and
  // always render. Visibility is decided purely by the tenant's
  // enabled_modules set — never by business_type.
  moduleKey?: OptionalModuleKey;
}
interface NavSection {
  titleKey: TKey | null;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    titleKey: null,
    items: [{ href: "/dashboard", labelKey: "navDashboard", icon: "home" }],
  },
  {
    titleKey: "navSales",
    items: [
      { href: "/pos", labelKey: "navPos", icon: "till", moduleKey: "pos" },
      { href: "/quotes", labelKey: "navQuotes", icon: "quote", moduleKey: "quotes" },
      { href: "/invoices", labelKey: "invoices", icon: "invoice" },
      { href: "/payments", labelKey: "payments", icon: "payment" },
      { href: "/customers", labelKey: "navCustomers", icon: "people" },
      { href: "/crm", labelKey: "navCrm", icon: "funnel", moduleKey: "crm" },
    ],
  },
  {
    titleKey: "navOperations",
    items: [
      { href: "/purchases", labelKey: "navPurchasing", icon: "cart" },
      { href: "/suppliers", labelKey: "navSuppliers", icon: "truck" },
      { href: "/inventory", labelKey: "navInventory", icon: "box" },
      { href: "/projects", labelKey: "navProjects", icon: "briefcase", moduleKey: "projects" },
      { href: "/documents", labelKey: "navDocuments", icon: "folder", moduleKey: "documents" },
    ],
  },
  {
    titleKey: "navHr",
    items: [
      { href: "/hr", labelKey: "navHrOverview", icon: "people" },
      { href: "/payroll", labelKey: "payroll", icon: "payroll" },
    ],
  },
  {
    titleKey: "navCompliance",
    items: [
      { href: "/finance", labelKey: "navFinance", icon: "coins", moduleKey: "finance" },
      { href: "/reports", labelKey: "navReports", icon: "chart" },
      { href: "/vat", labelKey: "vat", icon: "shield" },
      { href: "/controls", labelKey: "navControls", icon: "scale", moduleKey: "controls" },
    ],
  },
  {
    titleKey: null,
    items: [{ href: "/settings", labelKey: "navSettings", icon: "gear" }],
  },
];

/**
 * The authenticated application frame: icon sidebar + top bar with
 * quick-add and account chip. Guards every page in the (app) group.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  // Starts empty on server AND first client render (hydration must match
  // the exported HTML); the stored name is applied in an effect below.
  const [tenantName, setTenantName] = useState<string>("");
  // null = not yet loaded → show ALL optional modules so nothing flickers
  // away before /tenants/current resolves. Once loaded it holds the tenant's
  // enabled_modules set. The single source of truth is enabled_modules; the
  // shell never inspects business_type.
  const [modules, setModules] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    const stored = sessionStorage.getItem("jenga.tenantName");
    const storedModules = sessionStorage.getItem("jenga.modules");
    if (stored) setTenantName(stored);
    if (storedModules) {
      try {
        setModules(JSON.parse(storedModules) as string[]);
      } catch {
        /* corrupt cache → refetch below */
      }
    }
    // Fetch when either piece is missing (name and module list are cached
    // together off the same /tenants/current call).
    if (!stored || !storedModules) {
      api<{ name: string; enabled_modules: string[] }>("/tenants/current")
        .then((tn) => {
          sessionStorage.setItem("jenga.tenantName", tn.name);
          setTenantName(tn.name);
          const mods = tn.enabled_modules ?? [];
          sessionStorage.setItem("jenga.modules", JSON.stringify(mods));
          setModules(mods);
        })
        .catch(() => undefined);
    }
  }, [router]);

  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Any click outside the account chip closes its menu.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (): void => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const signOut = (): void => {
    sessionStorage.removeItem("jenga.tenantName");
    sessionStorage.removeItem("jenga.modules");
    clearTokens();
    router.replace("/");
  };

  const initials = tenantName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

  return (
    <div className="shell">
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="sidebar-brand">
          <Link href="/dashboard">
            Jenga <span className="logo-dot">ERP</span>
          </Link>
        </div>
        <nav>
          {NAV.map((section, si) => {
            // Core items (no moduleKey) always show. Optional items show only
            // when enabled. Until the module set loads (modules === null) show
            // everything so nothing flickers away on first paint.
            const visible = section.items.filter(
              (item) =>
                !item.moduleKey ||
                modules === null ||
                modules.includes(item.moduleKey),
            );
            if (visible.length === 0) return null; // empty section → no title
            return (
            <div key={si} className="nav-section">
              {section.titleKey && (
                <div className="nav-title">{t(section.titleKey)}</div>
              )}
              {visible.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`navlink${active ? " active" : ""}`}
                  >
                    {Icons[item.icon]}
                    {t(item.labelKey)}
                  </Link>
                );
              })}
            </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <LangToggle />
        </div>
      </aside>
      {open && (
        <div
          className="scrim"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="shell-main">
        <header className="topbar">
          <button
            type="button"
            className="hamburger"
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
          >
            ☰
          </button>
          <span className="topbar-tenant">{tenantName}</span>
          <span className="topbar-spacer" />
          <button
            type="button"
            className="topbar-search"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
          >
            <span className="topbar-search-icon">{Icons.search}</span>
            <span className="topbar-search-label">Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <Link
            href="/invoices/new"
            className="topbar-add"
            aria-label={t("newInvoice").replace("+ ", "")}
          >
            <span className="topbar-add-plus">{Icons.plus}</span>
            <span className="topbar-add-label">
              {t("newInvoice").replace("+ ", "")}
            </span>
          </Link>
          <span className="topbar-account">
            <button
              type="button"
              className="avatar"
              title={tenantName}
              aria-label="Account"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              {initials || "•"}
            </button>
            {menuOpen && (
              <div className="topbar-menu" onClick={(e) => e.stopPropagation()}>
                <div className="topbar-menu-head">{tenantName || "—"}</div>
                <Link href="/settings">{t("navSettings")}</Link>
                <button type="button" onClick={signOut}>
                  {Icons.signout} {t("signOut")}
                </button>
              </div>
            )}
          </span>
        </header>
        <main>{children}</main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
