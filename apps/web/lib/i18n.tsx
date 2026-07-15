"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Lean EN/SW dictionary (03-product-vision D5). Swahili reviewed for
 * business register; per-module strings join as their screens localize.
 */
export type Lang = "en" | "sw";

const DICT = {
  en: {
    tagline: "eTIMS invoicing · M-Pesa reconciliation · compliant books",
    yourName: "Your name",
    businessName: "Business name",
    email: "Email",
    password: "Password",
    signIn: "Sign in",
    createWorkspace: "Create workspace",
    newHere: "New business? Sign up",
    haveAccount: "Have an account? Sign in",
    chooseWorkspace: "Choose a workspace",
    open: "Open",
    signOut: "Sign out",
    cash: "Cash & M-Pesa",
    owed: "Owed to you",
    vatDue: "VAT owed to KRA",
    deadlines: "Statutory deadlines",
    days: "days",
    overdue: "OVERDUE",
    invoices: "Invoices",
    newInvoice: "+ New invoice",
    noInvoices: "No invoices yet. Create your first eTIMS invoice — it takes a minute.",
    payments: "Payments",
    payroll: "Payroll",
    purchases: "Purchases",
    vat: "VAT",
    customer: "Customer",
    total: "Total",
    status: "Status",
    navDashboard: "Dashboard",
    navSales: "Sales",
    navQuotes: "Quotes",
    navOperations: "Operations",
    navInventory: "Inventory",
    navCompliance: "Compliance",
    navReports: "Reports",
    navSettings: "Settings",
    search: "Search",
    allStatuses: "All statuses",
    navCustomers: "Customers",
    navSuppliers: "Suppliers",
    navHr: "HR",
    navHrOverview: "HR & Leave",
    navCrm: "CRM",
    navDocuments: "Documents",
    navProjects: "Projects",
    navPos: "Sell (POS)",
    navPurchaseOrders: "Purchase orders",
    navFinance: "Finance",
    navControls: "Controls",
    confirmSure: "Sure?",
    confirmYes: "Yes",
    confirmNo: "No",
    onbTitle: "Set up your business",
    onbIntro: "Four quick steps and you're ready to trade.",
    onbHide: "I know my way around — hide this",
    onbDone: "Done",
    onbStep1: "Name your first branch",
    onbStep1Hint:
      "Your main shop or office. We'll also set up a standard chart of accounts for you.",
    onbBranchName: "Branch name",
    onbCreateBranch: "Create branch",
    onbStep2: "Add your first customer",
    onbStep2Hint: "Who do you sell to most often?",
    onbCustomerName: "Customer name",
    onbPhone: "Phone (optional)",
    onbAddCustomer: "Add customer",
    onbSkip: "Skip for now",
    onbStep3: "Add what you sell",
    onbStep3Hint: "One product or service is enough to start.",
    onbItemName: "Item name",
    onbItemPrice: "Selling price (KES)",
    onbAddItem: "Add item",
    onbStep4: "Choose your path",
    onbStep4Hint: "You're set up — pick how you want to start.",
    onbPathInvoice: "Issue first invoice",
    onbPathPos: "Open the till",
    onbPathDemo: "Load full demo data instead",
    onbDemoLoading: "Loading demo data — this takes a few seconds…",
  },
  sw: {
    tagline: "Ankara za eTIMS · Ulinganisho wa M-Pesa · Hesabu safi",
    yourName: "Jina lako",
    businessName: "Jina la biashara",
    email: "Barua pepe",
    password: "Nenosiri",
    signIn: "Ingia",
    createWorkspace: "Fungua akaunti ya biashara",
    newHere: "Biashara mpya? Jisajili",
    haveAccount: "Una akaunti? Ingia",
    chooseWorkspace: "Chagua biashara",
    open: "Fungua",
    signOut: "Toka",
    cash: "Pesa taslimu na M-Pesa",
    owed: "Unadaiwa",
    vatDue: "VAT ya KRA",
    deadlines: "Tarehe za mwisho za KRA",
    days: "siku",
    overdue: "IMECHELEWA",
    invoices: "Ankara",
    newInvoice: "+ Ankara mpya",
    noInvoices: "Hakuna ankara bado. Tengeneza ankara yako ya kwanza ya eTIMS — dakika moja tu.",
    payments: "Malipo",
    payroll: "Mishahara",
    purchases: "Manunuzi",
    vat: "VAT",
    customer: "Mteja",
    total: "Jumla",
    status: "Hali",
    navDashboard: "Dashibodi",
    navSales: "Mauzo",
    navQuotes: "Nukuu za bei",
    navOperations: "Uendeshaji",
    navInventory: "Bidhaa",
    navCompliance: "Uzingatiaji",
    navReports: "Ripoti",
    navSettings: "Mipangilio",
    search: "Tafuta",
    allStatuses: "Hali zote",
    navCustomers: "Wateja",
    navSuppliers: "Wasambazaji",
    navHr: "Watumishi",
    navHrOverview: "HR na Likizo",
    navCrm: "CRM",
    navDocuments: "Nyaraka",
    navProjects: "Miradi",
    navPos: "Uza (POS)",
    navPurchaseOrders: "Oda za manunuzi",
    navFinance: "Fedha",
    navControls: "Udhibiti",
    confirmSure: "Una uhakika?",
    confirmYes: "Ndiyo",
    confirmNo: "Hapana",
    onbTitle: "Sanidi biashara yako",
    onbIntro: "Hatua nne fupi na uko tayari kufanya biashara.",
    onbHide: "Naijua vizuri — ficha hii",
    onbDone: "Imekamilika",
    onbStep1: "Taja tawi lako la kwanza",
    onbStep1Hint:
      "Duka au ofisi yako kuu. Tutakuandalia pia orodha ya kawaida ya akaunti.",
    onbBranchName: "Jina la tawi",
    onbCreateBranch: "Unda tawi",
    onbStep2: "Ongeza mteja wako wa kwanza",
    onbStep2Hint: "Unamuuzia nani mara nyingi zaidi?",
    onbCustomerName: "Jina la mteja",
    onbPhone: "Simu (si lazima)",
    onbAddCustomer: "Ongeza mteja",
    onbSkip: "Ruka kwa sasa",
    onbStep3: "Ongeza unachouza",
    onbStep3Hint: "Bidhaa au huduma moja inatosha kuanzia.",
    onbItemName: "Jina la bidhaa",
    onbItemPrice: "Bei ya kuuza (KES)",
    onbAddItem: "Ongeza bidhaa",
    onbStep4: "Chagua njia yako",
    onbStep4Hint: "Umejiandaa — chagua jinsi ya kuanza.",
    onbPathInvoice: "Toa ankara ya kwanza",
    onbPathPos: "Fungua kasha (POS)",
    onbPathDemo: "Pakia data ya mfano badala yake",
    onbDemoLoading: "Inapakia data ya mfano — subiri sekunde chache…",
  },
} as const;

export type TKey = keyof (typeof DICT)["en"];

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: TKey) => string;
}>({ lang: "en", setLang: () => undefined, t: (k) => DICT.en[k] });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const saved = localStorage.getItem("jenga.lang");
    if (saved === "sw" || saved === "en") setLangState(saved);
  }, []);
  const setLang = (l: Lang): void => {
    localStorage.setItem("jenga.lang", l);
    setLangState(l);
  };
  const t = (k: TKey): string => DICT[lang][k] ?? DICT.en[k];
  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useI18n() {
  return useContext(LangContext);
}

export function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <a
      href="#"
      aria-label="Badilisha lugha / switch language"
      onClick={(e) => {
        e.preventDefault();
        setLang(lang === "en" ? "sw" : "en");
      }}
    >
      {lang === "en" ? "Kiswahili" : "English"}
    </a>
  );
}
