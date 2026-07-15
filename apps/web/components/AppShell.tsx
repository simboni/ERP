"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, clearTokens, getTenantToken } from "@/lib/api";
import { LangToggle, useI18n, type TKey } from "@/lib/i18n";

interface NavItem {
  href: string;
  labelKey: TKey;
}
interface NavSection {
  titleKey: TKey | null;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    titleKey: null,
    items: [{ href: "/dashboard", labelKey: "navDashboard" }],
  },
  {
    titleKey: "navSales",
    items: [
      { href: "/quotes", labelKey: "navQuotes" },
      { href: "/invoices", labelKey: "invoices" },
      { href: "/payments", labelKey: "payments" },
    ],
  },
  {
    titleKey: "navOperations",
    items: [
      { href: "/purchases", labelKey: "purchases" },
      { href: "/inventory", labelKey: "navInventory" },
      { href: "/payroll", labelKey: "payroll" },
    ],
  },
  {
    titleKey: "navCompliance",
    items: [
      { href: "/vat", labelKey: "vat" },
      { href: "/reports", labelKey: "navReports" },
    ],
  },
  {
    titleKey: null,
    items: [{ href: "/settings", labelKey: "navSettings" }],
  },
];

/**
 * The authenticated application frame: fixed sidebar navigation + top bar.
 * Guards every page inside the (app) route group — no tenant token means
 * an immediate redirect to the login screen.
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

  // Close the mobile drawer on navigation.
  useEffect(() => setOpen(false), [pathname]);

  const signOut = (): void => {
    sessionStorage.removeItem("jenga.tenantName");
    clearTokens();
    router.replace("/");
  };

  return (
    <div className="shell">
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="sidebar-brand">
          <Link href="/dashboard">Jenga ERP</Link>
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
    </div>
  );
}
