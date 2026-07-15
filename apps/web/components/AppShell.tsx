"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, clearTokens, getTenantToken } from "@/lib/api";
import { CommandPalette } from "@/components/CommandPalette";
import { LangToggle, useI18n, type TKey } from "@/lib/i18n";

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
};

interface NavItem {
  href: string;
  labelKey: TKey;
  icon: keyof typeof Icons;
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
      { href: "/quotes", labelKey: "navQuotes", icon: "quote" },
      { href: "/invoices", labelKey: "invoices", icon: "invoice" },
      { href: "/payments", labelKey: "payments", icon: "payment" },
      { href: "/customers", labelKey: "navCustomers", icon: "people" },
      { href: "/crm", labelKey: "navCrm", icon: "chart" },
    ],
  },
  {
    titleKey: "navOperations",
    items: [
      { href: "/purchases", labelKey: "purchases", icon: "cart" },
      { href: "/suppliers", labelKey: "navSuppliers", icon: "truck" },
      { href: "/inventory", labelKey: "navInventory", icon: "box" },
      { href: "/documents", labelKey: "navDocuments", icon: "quote" },
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
      { href: "/vat", labelKey: "vat", icon: "shield" },
      { href: "/reports", labelKey: "navReports", icon: "chart" },
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
  const [tenantName, setTenantName] = useState<string>(() =>
    typeof window === "undefined"
      ? ""
      : (sessionStorage.getItem("jenga.tenantName") ?? ""),
  );
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
    if (!sessionStorage.getItem("jenga.tenantName")) {
      api<{ name: string }>("/tenants/current")
        .then((tn) => {
          sessionStorage.setItem("jenga.tenantName", tn.name);
          setTenantName(tn.name);
        })
        .catch(() => undefined);
    }
  }, [router]);

  useEffect(() => setOpen(false), [pathname]);

  const signOut = (): void => {
    sessionStorage.removeItem("jenga.tenantName");
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
          {NAV.map((section, si) => (
            <div key={si} className="nav-section">
              {section.titleKey && (
                <div className="nav-title">{t(section.titleKey)}</div>
              )}
              {section.items.map((item) => {
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
          ))}
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
            onClick={() => setPaletteOpen(true)}
          >
            🔍 Search <kbd>Ctrl K</kbd>
          </button>
          <Link href="/invoices/new" className="topbar-add">
            <span className="topbar-add-plus">{Icons.plus}</span>
            {t("newInvoice").replace("+ ", "")}
          </Link>
          <span className="avatar" title={tenantName}>
            {initials || "•"}
          </span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              signOut();
            }}
          >
            {t("signOut")}
          </a>
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
