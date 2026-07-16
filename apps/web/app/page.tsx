"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  api,
  getTenantToken,
  setRefreshToken,
  setTenantId,
  setTenantToken,
  setUserToken,
} from "@/lib/api";
import { LangToggle, useI18n } from "@/lib/i18n";
import { presetModules } from "@/lib/modules";
import { Icons } from "@/components/AppShell";

/* ------------------------------------------------------------------ *
 * Landing-page copy. English is primary; a lean Swahili layer covers
 * the nav + CTAs + section headings so the LangToggle is meaningful.
 * Body prose falls back to English when a Swahili string is absent.
 * ------------------------------------------------------------------ */
type Lang = "en" | "sw";
const COPY = {
  navProduct: { en: "Product", sw: "Bidhaa" },
  navIndustries: { en: "Industries", sw: "Biashara" },
  navFeatures: { en: "Features", sw: "Vipengele" },
  navPricing: { en: "Pricing", sw: "Bei" },
  signIn: { en: "Sign in", sw: "Ingia" },
  startFree: { en: "Start free", sw: "Anza bure" },
  tryLive: { en: "Try it live", sw: "Ijaribu sasa" },
  openDash: { en: "Open dashboard", sw: "Fungua dashibodi" },
  heroKicker: { en: "Kenya-first business platform", sw: "Jukwaa la biashara la Kenya" },
  heroTitle: {
    en: "Run your whole business.\nBuilt for Kenya.",
    sw: "Endesha biashara yako yote.\nImejengwa kwa Kenya.",
  },
  heroSub: {
    en: "POS, invoicing, payments, payroll and compliant books — one platform that files eTIMS, computes VAT and PAYE, and reconciles M-Pesa automatically. Pick your industry; it shows only the tools you need.",
    sw: "POS, ankara, malipo, mishahara na hesabu safi — jukwaa moja linalowasilisha eTIMS, kukokotoa VAT na PAYE, na kulinganisha M-Pesa kiotomatiki. Chagua sekta yako; linaonyesha zana unazohitaji tu.",
  },
  heroNote: {
    en: "No card required · 24-hour live demo · English & Kiswahili",
    sw: "Hakuna kadi · Onyesho la saa 24 · Kiingereza na Kiswahili",
  },
  trust: {
    en: "eTIMS ready · M-Pesa auto-reconcile · PAYE · NSSF · SHIF · Housing Levy · English & Kiswahili",
    sw: "eTIMS tayari · M-Pesa · PAYE · NSSF · SHIF · Ushuru wa Nyumba · Kiingereza na Kiswahili",
  },
  industriesTitle: { en: "One platform, tailored to your trade", sw: "Jukwaa moja, kwa biashara yako" },
  industriesSub: {
    en: "Tell us what you do and Jenga switches on the right tools — a fast till for a duka, projects for a consultancy, rooms for a hotel. No bloat, nothing you don't need.",
    sw: "Tuambie unachofanya na Jenga huwasha zana sahihi — kasha la haraka kwa duka, miradi kwa ushauri, vyumba kwa hoteli. Hakuna vitu vya ziada.",
  },
  industriesPick: { en: "Pick your industry to launch a live demo →", sw: "Chagua sekta yako kuanzisha onyesho →" },
  featuresTitle: { en: "Every module a real business needs", sw: "Kila moduli biashara halisi inahitaji" },
  featuresSub: {
    en: "Turn modules on or off as you grow. Core tools are always included.",
    sw: "Washa au zima moduli unavyokua. Zana za msingi zipo daima.",
  },
  whyTitle: { en: "Why Kenyan businesses choose Jenga", sw: "Kwa nini biashara za Kenya huchagua Jenga" },
  howTitle: { en: "Live in three steps", sw: "Anza kwa hatua tatu" },
  proofTitle: { en: "Built for how Kenya trades", sw: "Imejengwa kwa jinsi Kenya inavyofanya biashara" },
  pricingTitle: { en: "Start free, pay as you grow", sw: "Anza bure, lipa unavyokua" },
  pricingSub: {
    en: "Honest, simple pricing. Indicative tiers shown below — no hidden fees.",
    sw: "Bei rahisi na wazi. Viwango vya mfano hapa chini — hakuna gharama za siri.",
  },
  finalTitle: { en: "See your business running in Jenga — today", sw: "Ona biashara yako ikiendeshwa kwenye Jenga — leo" },
  finalSub: {
    en: "Spin up a pre-loaded workspace in seconds. It clears itself in 24 hours.",
    sw: "Fungua eneo-kazi lililojaa data kwa sekunde. Hujifuta baada ya saa 24.",
  },
  demoBuilding: { en: "Building your demo workspace…", sw: "Inatengeneza eneo-kazi lako…" },
  demoExpiry: {
    en: "This is a 24-hour demo — your data clears automatically.",
    sw: "Hili ni onyesho la saa 24 — data yako hujifuta kiotomatiki.",
  },
} as const;

type IndustryChip = { key: string; label: { en: string; sw: string }; emoji: string };
const INDUSTRIES: IndustryChip[] = [
  { key: "retail", label: { en: "Retail", sw: "Rejareja" }, emoji: "🛒" },
  { key: "restaurant", label: { en: "Restaurant", sw: "Mkahawa" }, emoji: "🍽️" },
  { key: "hotel", label: { en: "Hotel", sw: "Hoteli" }, emoji: "🏨" },
  { key: "salon", label: { en: "Salon", sw: "Salon" }, emoji: "💇" },
  { key: "manufacturing", label: { en: "Manufacturing", sw: "Uzalishaji" }, emoji: "🏭" },
  { key: "auto", label: { en: "Auto", sw: "Magari" }, emoji: "🚗" },
  { key: "services", label: { en: "Pro services", sw: "Huduma" }, emoji: "💼" },
  { key: "general", label: { en: "General", sw: "Kwa jumla" }, emoji: "🏢" },
];

type Feature = { icon: keyof typeof Icons; title: { en: string; sw: string }; body: { en: string; sw: string } };
const FEATURES: Feature[] = [
  { icon: "till", title: { en: "Point of sale", sw: "Kasha (POS)" }, body: { en: "A fast, offline-friendly till for over-the-counter sales.", sw: "Kasha la haraka kwa mauzo ya kaunta." } },
  { icon: "invoice", title: { en: "Invoicing & quotes", sw: "Ankara na nukuu" }, body: { en: "Send eTIMS invoices and estimates that convert in one tap.", sw: "Tuma ankara za eTIMS na nukuu zinazogeuka kwa mguso mmoja." } },
  { icon: "payment", title: { en: "Payments & reconciliation", sw: "Malipo na ulinganisho" }, body: { en: "Cash, bank and M-Pesa — matched to invoices automatically.", sw: "Pesa, benki na M-Pesa — vinalinganishwa na ankara moja kwa moja." } },
  { icon: "cart", title: { en: "Purchasing", sw: "Manunuzi" }, body: { en: "Raise orders, receive stock and track supplier bills.", sw: "Toa oda, pokea bidhaa na fuatilia bili za wasambazaji." } },
  { icon: "box", title: { en: "Inventory", sw: "Bidhaa" }, body: { en: "Real-time stock across branches with low-stock alerts.", sw: "Hisa za wakati halisi kwa matawi na tahadhari za upungufu." } },
  { icon: "payroll", title: { en: "HR & payroll", sw: "HR na mishahara" }, body: { en: "PAYE, NSSF, SHIF and Housing Levy computed for you.", sw: "PAYE, NSSF, SHIF na Ushuru wa Nyumba vinakokotolewa." } },
  { icon: "funnel", title: { en: "CRM", sw: "CRM" }, body: { en: "Track leads and move deals through your pipeline.", sw: "Fuatilia wateja na sogeza biashara kwenye njia yako." } },
  { icon: "briefcase", title: { en: "Projects", sw: "Miradi" }, body: { en: "Run jobs with tasks, time and billable expenses.", sw: "Endesha kazi kwa majukumu, muda na gharama." } },
  { icon: "folder", title: { en: "Documents", sw: "Nyaraka" }, body: { en: "File contracts and licences with expiry alerts.", sw: "Hifadhi mikataba na leseni na tahadhari za muda." } },
  { icon: "coins", title: { en: "Budgets & assets", sw: "Bajeti na mali" }, body: { en: "Plan budgets and track fixed assets and depreciation.", sw: "Panga bajeti na fuatilia mali za kudumu." } },
  { icon: "scale", title: { en: "Approvals & audit", sw: "Idhini na ukaguzi" }, body: { en: "Approval controls and a full, tamper-proof audit trail.", sw: "Udhibiti wa idhini na kumbukumbu kamili za ukaguzi." } },
  { icon: "chart", title: { en: "Reports", sw: "Ripoti" }, body: { en: "P&L, balance sheet and VAT returns — audit-ready.", sw: "Faida/Hasara, mizania na marejesho ya VAT — tayari kwa ukaguzi." } },
];

type Why = { emoji: string; title: { en: string; sw: string }; body: { en: string; sw: string } };
const WHY: Why[] = [
  { emoji: "🧾", title: { en: "KRA eTIMS, done", sw: "KRA eTIMS, imekamilika" }, body: { en: "Every sale is fiscalised to eTIMS and VAT at 16% is worked out and filed for you.", sw: "Kila mauzo linawasilishwa eTIMS na VAT ya 16% inakokotolewa na kuwasilishwa." } },
  { emoji: "📱", title: { en: "M-Pesa that reconciles", sw: "M-Pesa inayolinganisha" }, body: { en: "Payments land against the right invoice on their own — no more manual matching.", sw: "Malipo yanawekwa kwenye ankara sahihi yenyewe — bila kulinganisha kwa mkono." } },
  { emoji: "👥", title: { en: "Payroll that complies", sw: "Mishahara inayotii" }, body: { en: "PAYE, NSSF, SHIF and the Housing Levy are computed to the shilling, every month.", sw: "PAYE, NSSF, SHIF na Ushuru wa Nyumba vinakokotolewa kila mwezi." } },
  { emoji: "🔐", title: { en: "Role-based access", sw: "Ufikiaji kwa majukumu" }, body: { en: "Give your cashier the till, your HR person HR only. Owners see everything.", sw: "Mpe keshia kasha, mtu wa HR aone HR pekee. Wamiliki wanaona yote." } },
  { emoji: "📚", title: { en: "Proper books", sw: "Hesabu sahihi" }, body: { en: "Double-entry accounting behind every screen — P&L and balance sheet, always current.", sw: "Uhasibu wa kuingiza mara mbili nyuma ya kila skrini — daima wa sasa." } },
  { emoji: "🌍", title: { en: "English & Kiswahili", sw: "Kiingereza na Kiswahili" }, body: { en: "Work in the language your team is comfortable with, on any phone.", sw: "Fanya kazi kwa lugha timu yako inavyopenda, kwa simu yoyote." } },
];

export default function LandingPage() {
  const router = useRouter();
  const { lang } = useI18n();
  const L = lang as Lang;
  const tr = (c: { en: string; sw: string }): string => (L === "sw" ? c.sw : c.en) || c.en;

  const [signedIn, setSignedIn] = useState(false);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [demoError, setDemoError] = useState("");

  useEffect(() => {
    setSignedIn(!!getTenantToken());
  }, []);

  const launchDemo = async (businessType: string): Promise<void> => {
    if (demoBusy) return;
    setDemoError("");
    setDemoBusy(businessType);
    try {
      // 1. PUBLIC demo provisioning — no auth.
      const demo = await api<{
        userToken: string;
        refreshToken: string;
        tenantId: string;
        tenantName: string;
        email: string;
        expiresAt: string;
      }>("/auth/demo", { method: "POST", body: { businessType } });

      // 2. Store the user session exactly as login does.
      setUserToken(demo.userToken);
      setRefreshToken(demo.refreshToken);

      // 3. Exchange for a tenant-scoped access token.
      const tok = await api<{ accessToken: string }>("/auth/tenant-token", {
        method: "POST",
        body: { tenantId: demo.tenantId },
        token: demo.userToken,
      });
      setTenantToken(tok.accessToken);
      setTenantId(demo.tenantId);

      // 4. Prime the sidebar cache the way login/AppShell expect so the
      //    industry-tailored, role-scoped nav renders immediately (a demo
      //    user is the workspace owner).
      try {
        sessionStorage.setItem("jenga.tenantName", demo.tenantName);
        sessionStorage.setItem("jenga.role", "owner");
        sessionStorage.setItem(
          "jenga.modules",
          JSON.stringify(presetModules(businessType)),
        );
      } catch {
        /* private mode: AppShell refetches */
      }

      // 5. Into the running workspace.
      router.push("/dashboard");
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : "Could not start the demo. Please try again.");
      setDemoBusy(null);
    }
  };

  return (
    <div className="lp">
      {/* ---- sticky nav ---- */}
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <a href="#top" className="lp-logo">
            Jenga <span>ERP</span>
          </a>
          <nav className="lp-nav-links">
            <a href="#industries">{tr(COPY.navIndustries)}</a>
            <a href="#features">{tr(COPY.navFeatures)}</a>
            <a href="#why">{tr(COPY.navProduct)}</a>
            <a href="#pricing">{tr(COPY.navPricing)}</a>
          </nav>
          <div className="lp-nav-actions">
            <span className="lp-lang"><LangToggle /></span>
            {signedIn ? (
              <Link href="/dashboard" className="lp-btn lp-btn-primary">
                {tr(COPY.openDash)} →
              </Link>
            ) : (
              <>
                <Link href="/login" className="lp-btn lp-btn-ghost lp-hide-sm">
                  {tr(COPY.signIn)}
                </Link>
                <Link href="/login" className="lp-btn lp-btn-primary">
                  {tr(COPY.startFree)}
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ---- hero ---- */}
      <section className="lp-hero" id="top">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy lp-reveal">
            <span className="lp-kicker">{tr(COPY.heroKicker)}</span>
            <h1 className="lp-h1">{tr(COPY.heroTitle)}</h1>
            <p className="lp-lead">{tr(COPY.heroSub)}</p>
            <div className="lp-hero-cta">
              <a href="#industries" className="lp-btn lp-btn-primary lp-btn-lg">
                {tr(COPY.tryLive)}
              </a>
              <Link href="/login" className="lp-btn lp-btn-outline lp-btn-lg">
                {tr(COPY.startFree)}
              </Link>
            </div>
            <p className="lp-hero-note">{tr(COPY.heroNote)}</p>
          </div>
          <div className="lp-hero-visual lp-reveal" aria-hidden="true">
            <DashboardMock />
          </div>
        </div>
      </section>

      {/* ---- trust strip ---- */}
      <div className="lp-trust">
        <div className="lp-trust-track">
          <span>{tr(COPY.trust)}</span>
          <span aria-hidden="true">{tr(COPY.trust)}</span>
        </div>
      </div>

      {/* ---- industries / demo launcher ---- */}
      <section className="lp-section" id="industries">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.industriesTitle)}</h2>
          <p className="lp-section-sub">{tr(COPY.industriesSub)}</p>
        </div>
        <p className="lp-demo-prompt">{tr(COPY.industriesPick)}</p>
        <div className="lp-chips">
          {INDUSTRIES.map((ind) => (
            <button
              key={ind.key}
              type="button"
              className={`lp-chip${demoBusy === ind.key ? " loading" : ""}`}
              disabled={!!demoBusy}
              onClick={() => void launchDemo(ind.key)}
            >
              <span className="lp-chip-emoji">{ind.emoji}</span>
              {tr(ind.label)}
            </button>
          ))}
        </div>
        {demoError && <p className="lp-demo-err">{demoError}</p>}
        <p className="lp-demo-fine">{tr(COPY.demoExpiry)}</p>
      </section>

      {/* ---- features grid ---- */}
      <section className="lp-section lp-section-alt" id="features">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.featuresTitle)}</h2>
          <p className="lp-section-sub">{tr(COPY.featuresSub)}</p>
        </div>
        <div className="lp-feature-grid">
          {FEATURES.map((f) => (
            <div className="lp-feature" key={f.title.en}>
              <span className="lp-feature-icon">{Icons[f.icon]}</span>
              <div>
                <h3>{tr(f.title)}</h3>
                <p>{tr(f.body)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- why jenga ---- */}
      <section className="lp-section" id="why">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.whyTitle)}</h2>
        </div>
        <div className="lp-why-grid">
          {WHY.map((w) => (
            <div className="lp-why" key={w.title.en}>
              <span className="lp-why-emoji">{w.emoji}</span>
              <h3>{tr(w.title)}</h3>
              <p>{tr(w.body)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="lp-section lp-section-alt">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.howTitle)}</h2>
        </div>
        <div className="lp-steps">
          <div className="lp-step">
            <span className="lp-step-no">1</span>
            <h3>{L === "sw" ? "Chagua sekta yako" : "Pick your industry"}</h3>
            <p>{L === "sw" ? "Jenga huwasha zana zinazofaa biashara yako mara moja." : "Jenga switches on the tools that fit your trade, instantly."}</p>
          </div>
          <div className="lp-step">
            <span className="lp-step-no">2</span>
            <h3>{L === "sw" ? "Ongeza biashara yako" : "Add your business"}</h3>
            <p>{L === "sw" ? "Bidhaa, wateja na wafanyakazi — au anza na data ya mfano." : "Products, customers and staff — or start from sample data."}</p>
          </div>
          <div className="lp-step">
            <span className="lp-step-no">3</span>
            <h3>{L === "sw" ? "Anza kufanya biashara" : "Start trading"}</h3>
            <p>{L === "sw" ? "Uza, toa ankara na uzingatie sheria kuanzia siku ya kwanza." : "Sell, invoice and stay compliant from day one."}</p>
          </div>
        </div>
      </section>

      {/* ---- social proof (generic placeholders) ---- */}
      <section className="lp-section" id="proof">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.proofTitle)}</h2>
        </div>
        <div className="lp-quotes">
          <figure className="lp-quote">
            <blockquote>“eTIMS used to eat my evenings. Now every receipt is filed the moment I ring it up.”</blockquote>
            <figcaption>— Duka owner, Nairobi</figcaption>
          </figure>
          <figure className="lp-quote">
            <blockquote>“Payroll with SHIF and the Housing Levy is done in minutes. It just adds up correctly.”</blockquote>
            <figcaption>— Restaurant manager, Mombasa</figcaption>
          </figure>
          <figure className="lp-quote">
            <blockquote>“M-Pesa payments match themselves to invoices. My books finally balance on their own.”</blockquote>
            <figcaption>— Hardware supplier, Nakuru</figcaption>
          </figure>
        </div>
        <p className="lp-quote-note">
          {L === "sw" ? "Maoni ya mfano yanayoonyesha matukio ya kawaida ya wateja." : "Illustrative quotes representing common customer outcomes."}
        </p>
      </section>

      {/* ---- pricing teaser ---- */}
      <section className="lp-section lp-section-alt" id="pricing">
        <div className="lp-section-head">
          <h2 className="lp-h2">{tr(COPY.pricingTitle)}</h2>
          <p className="lp-section-sub">{tr(COPY.pricingSub)}</p>
        </div>
        <div className="lp-tiers">
          <div className="lp-tier">
            <span className="lp-tier-name">Starter</span>
            <span className="lp-tier-price">Free</span>
            <p className="lp-tier-tag">For a single shop finding its feet.</p>
            <ul>
              <li>POS, invoicing & eTIMS</li>
              <li>M-Pesa reconciliation</li>
              <li>1 branch · up to 2 users</li>
            </ul>
            <Link href="/login" className="lp-btn lp-btn-outline lp-tier-cta">{tr(COPY.startFree)}</Link>
          </div>
          <div className="lp-tier lp-tier-featured">
            <span className="lp-tier-badge">Most popular</span>
            <span className="lp-tier-name">Growth</span>
            <span className="lp-tier-price">Pay as you grow</span>
            <p className="lp-tier-tag">For a growing business with a team.</p>
            <ul>
              <li>Everything in Starter</li>
              <li>Payroll, HR, purchasing & inventory</li>
              <li>Multi-branch · role-based access</li>
            </ul>
            <a href="#industries" className="lp-btn lp-btn-primary lp-tier-cta">{tr(COPY.tryLive)}</a>
          </div>
          <div className="lp-tier">
            <span className="lp-tier-name">Enterprise</span>
            <span className="lp-tier-price">Let's talk</span>
            <p className="lp-tier-tag">For groups needing controls & scale.</p>
            <ul>
              <li>Everything in Growth</li>
              <li>Approvals, audit trail & controls</li>
              <li>Priority support · onboarding</li>
            </ul>
            <Link href="/login" className="lp-btn lp-btn-outline lp-tier-cta">{tr(COPY.signIn)}</Link>
          </div>
        </div>
        <p className="lp-quote-note">
          {L === "sw" ? "Viwango vya mfano — bei kamili itatangazwa." : "Indicative tiers — full pricing to be announced."}
        </p>
      </section>

      {/* ---- final CTA ---- */}
      <section className="lp-final">
        <h2 className="lp-h2">{tr(COPY.finalTitle)}</h2>
        <p>{tr(COPY.finalSub)}</p>
        <div className="lp-final-cta">
          <a href="#industries" className="lp-btn lp-btn-primary lp-btn-lg">{tr(COPY.tryLive)}</a>
          {!signedIn && (
            <Link href="/login" className="lp-btn lp-btn-outline lp-btn-lg lp-final-outline">
              {tr(COPY.startFree)}
            </Link>
          )}
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <a href="#top" className="lp-logo">Jenga <span>ERP</span></a>
            <p>{L === "sw" ? "Jukwaa la biashara lililojengwa kwa Kenya." : "The all-in-one business platform built for Kenya."}</p>
          </div>
          <div className="lp-footer-links">
            <a href="#features">{tr(COPY.navFeatures)}</a>
            <a href="#industries">{tr(COPY.navIndustries)}</a>
            <a href="#pricing">{tr(COPY.navPricing)}</a>
            <Link href="/login">{tr(COPY.signIn)}</Link>
            <span className="lp-lang"><LangToggle /></span>
          </div>
        </div>
        <div className="lp-footer-legal">
          © {new Date().getFullYear()} SMP Eventures · Jenga ERP
        </div>
      </footer>

      {/* ---- demo loading overlay ---- */}
      {demoBusy && (
        <div className="lp-demo-overlay" role="alert" aria-live="assertive">
          <div className="lp-demo-card">
            <span className="lp-spinner" aria-hidden="true" />
            <strong>{tr(COPY.demoBuilding)}</strong>
            <span className="lp-demo-sub">{tr(COPY.demoExpiry)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* Stylized, purely-decorative product visual — CSS/SVG only, no images. */
function DashboardMock() {
  return (
    <div className="lp-mock">
      <div className="lp-mock-bar">
        <span /><span /><span />
      </div>
      <div className="lp-mock-body">
        <div className="lp-mock-side">
          <div className="lp-mock-brand">Jenga</div>
          <span className="lp-mock-nav active" />
          <span className="lp-mock-nav" />
          <span className="lp-mock-nav" />
          <span className="lp-mock-nav" />
          <span className="lp-mock-nav" />
        </div>
        <div className="lp-mock-main">
          <div className="lp-mock-tiles">
            <div className="lp-mock-tile t1"><span className="lp-mock-tval">KES 482,300</span><span className="lp-mock-tlab">Cash & M-Pesa</span></div>
            <div className="lp-mock-tile t2"><span className="lp-mock-tval">KES 216,900</span><span className="lp-mock-tlab">Owed to you</span></div>
            <div className="lp-mock-tile t3"><span className="lp-mock-tval">KES 38,120</span><span className="lp-mock-tlab">VAT due</span></div>
          </div>
          <div className="lp-mock-chart">
            <div className="lp-mock-bars">
              {[42, 58, 36, 70, 52, 84, 63, 78].map((h, i) => (
                <span key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className="lp-mock-rows">
            <div className="lp-mock-row"><span className="lp-mock-dot" /><span className="lp-mock-line w40" /><span className="lp-mock-pill paid">Paid</span></div>
            <div className="lp-mock-row"><span className="lp-mock-dot" /><span className="lp-mock-line w60" /><span className="lp-mock-pill sent">Sent</span></div>
            <div className="lp-mock-row"><span className="lp-mock-dot" /><span className="lp-mock-line w30" /><span className="lp-mock-pill due">Due</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
