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
    navCompliance: "Finance & compliance",
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
    navPurchasing: "Purchasing",
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
    setTitle: "Settings",
    setSaved: "Saved.",
    setSave: "Save changes",
    setTabProfile: "Business profile",
    setTabBranches: "Branches",
    setTabTax: "Tax & numbering",
    setTabPayments: "Payment channels",
    setTabAccount: "Account & security",
    setProfileIntro:
      "Your business identity. These details print on invoices, quotes and receipts.",
    setDisplayName: "Display name",
    setLegalName: "Registered / legal name",
    setKraPin: "KRA PIN",
    setVatNumber: "VAT number",
    setPhone: "Phone",
    setEmail: "Email",
    setPostalAddress: "Postal address",
    setPhysicalAddress: "Physical address",
    setCurrency: "Currency (ISO code)",
    setBranchesIntro:
      "Shops, outlets and locations. Every sale, till and fiscal document is tagged to a branch.",
    setBranchCode: "Code",
    setBranchName: "Name",
    setBranchPhone: "Phone",
    setBranchAddress: "Address",
    setBranchDefault: "Default",
    setBranchActive: "Active",
    setBranchAdd: "Add branch",
    setBranchEdit: "Edit",
    setBranchSetDefault: "Make default",
    setBranchDeactivate: "Deactivate",
    setBranchReactivate: "Reactivate",
    setBranchNone: "No branches yet. Add your first shop or location.",
    setTaxIntro:
      "Defaults applied to new items and documents. Change them any time.",
    setDefaultVat: "Default VAT rate (%)",
    setPricesInclusive: "Item prices already include VAT",
    setInvoicePrefix: "Invoice number prefix",
    setNextInvoice: "Next invoice number",
    setQuotePrefix: "Quote number prefix",
    setNextQuote: "Next quote number",
    setFiscalYearStart: "Financial year starts (month)",
    setPaymentTerms: "Default payment terms (days)",
    setInvoiceFooter: "Invoice footer note",
    setReadOnly: "Read-only — assigned automatically when issued.",
    setOwnerOnly: "Owner and admins can change these.",
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
    navCompliance: "Fedha na uzingatiaji",
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
    navPurchasing: "Manunuzi",
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
    setTitle: "Mipangilio",
    setSaved: "Imehifadhiwa.",
    setSave: "Hifadhi mabadiliko",
    setTabProfile: "Wasifu wa biashara",
    setTabBranches: "Matawi",
    setTabTax: "Kodi na nambari",
    setTabPayments: "Njia za malipo",
    setTabAccount: "Akaunti na usalama",
    setProfileIntro:
      "Utambulisho wa biashara yako. Maelezo haya huchapishwa kwenye ankara, nukuu na risiti.",
    setDisplayName: "Jina la kuonyesha",
    setLegalName: "Jina lililosajiliwa / rasmi",
    setKraPin: "PIN ya KRA",
    setVatNumber: "Nambari ya VAT",
    setPhone: "Simu",
    setEmail: "Barua pepe",
    setPostalAddress: "Anwani ya posta",
    setPhysicalAddress: "Anwani ya mahali",
    setCurrency: "Sarafu (msimbo wa ISO)",
    setBranchesIntro:
      "Maduka, matawi na maeneo. Kila mauzo, kasha na hati ya kodi huhusishwa na tawi.",
    setBranchCode: "Msimbo",
    setBranchName: "Jina",
    setBranchPhone: "Simu",
    setBranchAddress: "Anwani",
    setBranchDefault: "Chaguo-msingi",
    setBranchActive: "Inatumika",
    setBranchAdd: "Ongeza tawi",
    setBranchEdit: "Hariri",
    setBranchSetDefault: "Weka chaguo-msingi",
    setBranchDeactivate: "Zima",
    setBranchReactivate: "Washa tena",
    setBranchNone: "Hakuna matawi bado. Ongeza duka au eneo lako la kwanza.",
    setTaxIntro:
      "Chaguo-msingi zinazotumika kwa bidhaa na hati mpya. Badilisha wakati wowote.",
    setDefaultVat: "Kiwango cha VAT cha kawaida (%)",
    setPricesInclusive: "Bei za bidhaa tayari zinajumuisha VAT",
    setInvoicePrefix: "Kiambishi cha nambari ya ankara",
    setNextInvoice: "Nambari ya ankara inayofuata",
    setQuotePrefix: "Kiambishi cha nambari ya nukuu",
    setNextQuote: "Nambari ya nukuu inayofuata",
    setFiscalYearStart: "Mwaka wa fedha huanza (mwezi)",
    setPaymentTerms: "Masharti ya malipo ya kawaida (siku)",
    setInvoiceFooter: "Ujumbe wa chini wa ankara",
    setReadOnly: "Kusoma tu — hutolewa kiotomatiki wakati wa kutoa.",
    setOwnerOnly: "Mmiliki na wasimamizi wanaweza kubadilisha haya.",
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
