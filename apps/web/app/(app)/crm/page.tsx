"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes0 } from "@/lib/api";

interface Contact {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  stage: "lead" | "opportunity" | "customer";
  source: string | null;
  customer_id: string | null;
  open_deals: number;
}
interface Deal {
  id: string;
  title: string;
  value_cents: string;
  stage: "new" | "qualified" | "proposal" | "won" | "lost";
  expected_close: string | null;
  quote_id: string | null;
  contact_name: string;
  contact_id: string;
}
interface Activity {
  id: string;
  kind: string;
  body: string;
  due_date: string | null;
  done: boolean;
  contact_name: string;
  deal_title: string | null;
  created_at: string;
}

const DEAL_STAGES: { key: Deal["stage"]; label: string }[] = [
  { key: "new", label: "New" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal", label: "Proposal" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];
const CONTACT_STAGES: Contact["stage"][] = ["lead", "opportunity", "customer"];

type Tab = "pipeline" | "contacts" | "activities";
const d10 = (s: string | null): string => s?.slice(0, 10) ?? "";

export default function CrmPage() {
  const [tab, setTab] = useState<Tab>("pipeline");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  // forms
  const [cName, setCName] = useState("");
  const [cCompany, setCCompany] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [dContact, setDContact] = useState("");
  const [dTitle, setDTitle] = useState("");
  const [dValue, setDValue] = useState("");
  const [aContact, setAContact] = useState("");
  const [aKind, setAKind] = useState("note");
  const [aBody, setABody] = useState("");
  const [aDue, setADue] = useState("");

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "failed");

  const load = useCallback(() => {
    Promise.all([
      api<Contact[]>("/tenants/current/crm/contacts"),
      api<Deal[]>("/tenants/current/crm/deals"),
      api<Activity[]>("/tenants/current/crm/activities"),
    ])
      .then(([c, d, a]) => {
        setContacts(c);
        setDeals(d);
        setActivities(a);
      })
      .catch(fail);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      if (note) setMsg(note);
      load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <h1>CRM</h1>
      <div className="tabs">
        {(
          [
            ["pipeline", "Pipeline"],
            ["contacts", "Contacts"],
            ["activities", "Activities"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => {
              setTab(key);
              setError("");
              setMsg("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {msg && <p className="muted">{msg}</p>}

      {tab === "pipeline" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>New deal</h3>
            </div>
            <div className="row">
              <div>
                <label>Contact</label>
                <select
                  value={dContact}
                  onChange={(e) => setDContact(e.target.value)}
                >
                  <option value="">Select…</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.company ? ` (${c.company})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Deal title</label>
                <input
                  value={dTitle}
                  onChange={(e) => setDTitle(e.target.value)}
                  placeholder="e.g. Office fit-out supply"
                />
              </div>
              <div>
                <label>Value (KES)</label>
                <input
                  type="number"
                  value={dValue}
                  onChange={(e) => setDValue(e.target.value)}
                />
              </div>
            </div>
            <button
              onClick={() =>
                void act(
                  () =>
                    api("/tenants/current/crm/deals", {
                      method: "POST",
                      body: {
                        contactId: dContact,
                        title: dTitle,
                        valueCents: Math.round(Number(dValue || 0) * 100),
                      },
                    }),
                  "Deal added.",
                )
              }
            >
              Add deal
            </button>
            {contacts.length === 0 && (
              <p className="muted">Add a contact first (Contacts tab).</p>
            )}
          </div>

          <div className="pipeline">
            {DEAL_STAGES.map(({ key, label }) => {
              const col = deals.filter((d) => d.stage === key);
              const total = col.reduce(
                (s, d) => s + Number(d.value_cents),
                0,
              );
              return (
                <div key={key} className="pipe-col">
                  <div className="pipe-head">
                    <span>{label}</span>
                    <span className="muted">
                      {col.length} · {fmtKes0(total)}
                    </span>
                  </div>
                  {col.map((d) => (
                    <div key={d.id} className="pipe-card">
                      <strong>{d.title}</strong>
                      <span className="muted">{d.contact_name}</span>
                      <span className="kes">{fmtKes0(d.value_cents)}</span>
                      <select
                        value={d.stage}
                        onChange={(e) =>
                          void act(() =>
                            api(`/tenants/current/crm/deals/${d.id}/stage`, {
                              method: "POST",
                              body: { stage: e.target.value },
                            }),
                          )
                        }
                      >
                        {DEAL_STAGES.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      {d.quote_id ? (
                        <Link href="/quotes" className="muted">
                          Quote created ✓
                        </Link>
                      ) : (
                        d.stage !== "lost" && (
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              void act(
                                () =>
                                  api(
                                    `/tenants/current/crm/deals/${d.id}/quote`,
                                    { method: "POST" },
                                  ),
                                "Draft quote created — see Quotes.",
                              );
                            }}
                          >
                            → Quote
                          </a>
                        )
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === "contacts" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>New contact</h3>
            </div>
            <div className="row">
              <div>
                <label>Name</label>
                <input value={cName} onChange={(e) => setCName(e.target.value)} />
              </div>
              <div>
                <label>Company</label>
                <input
                  value={cCompany}
                  onChange={(e) => setCCompany(e.target.value)}
                />
              </div>
              <div>
                <label>Phone</label>
                <input
                  value={cPhone}
                  onChange={(e) => setCPhone(e.target.value)}
                />
              </div>
            </div>
            <button
              onClick={() =>
                void act(
                  () =>
                    api("/tenants/current/crm/contacts", {
                      method: "POST",
                      body: { name: cName, company: cCompany, phone: cPhone },
                    }),
                  "Contact added as lead.",
                )
              }
            >
              Add lead
            </button>
          </div>
          <div className="card">
            {contacts.length === 0 ? (
              <div className="empty">
                <span className="empty-icon">🤝</span>
                <p>No contacts yet — add your first lead above.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Stage</th>
                    <th className="num">Open deals</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.company && (
                          <>
                            <br />
                            <span className="muted">{c.company}</span>
                          </>
                        )}
                      </td>
                      <td className="muted">{c.phone ?? c.email ?? "—"}</td>
                      <td>
                        <span
                          className={`pill ${
                            c.stage === "customer"
                              ? "paid"
                              : c.stage === "opportunity"
                                ? "issued"
                                : "pending"
                          }`}
                        >
                          {c.stage}
                        </span>
                      </td>
                      <td className="num">{c.open_deals}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {CONTACT_STAGES.indexOf(c.stage) < 2 && (
                          <button
                            type="button"
                            className="secondary"
                            style={{ marginTop: 0, padding: "4px 12px" }}
                            onClick={() =>
                              void act(
                                () =>
                                  api(
                                    `/tenants/current/crm/contacts/${c.id}/stage`,
                                    {
                                      method: "POST",
                                      body: {
                                        stage:
                                          CONTACT_STAGES[
                                            CONTACT_STAGES.indexOf(c.stage) + 1
                                          ],
                                      },
                                    },
                                  ),
                                c.stage === "opportunity"
                                  ? "Promoted to customer — now invoiceable."
                                  : "Promoted to opportunity.",
                              )
                            }
                          >
                            Promote →
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === "activities" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Log activity / follow-up</h3>
            </div>
            <div className="row">
              <div>
                <label>Contact</label>
                <select
                  value={aContact}
                  onChange={(e) => setAContact(e.target.value)}
                >
                  <option value="">Select…</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Type</label>
                <select value={aKind} onChange={(e) => setAKind(e.target.value)}>
                  <option value="note">Note</option>
                  <option value="call">Call</option>
                  <option value="meeting">Meeting</option>
                  <option value="task">Task</option>
                </select>
              </div>
              <div>
                <label>Follow-up date (optional)</label>
                <input
                  type="date"
                  value={aDue}
                  onChange={(e) => setADue(e.target.value)}
                />
              </div>
            </div>
            <label>Details</label>
            <input
              value={aBody}
              onChange={(e) => setABody(e.target.value)}
              placeholder="e.g. Called about the fit-out quote — call back Tuesday"
            />
            <button
              onClick={() =>
                void act(
                  () =>
                    api("/tenants/current/crm/activities", {
                      method: "POST",
                      body: {
                        contactId: aContact,
                        kind: aKind,
                        body: aBody,
                        dueDate: aDue || undefined,
                      },
                    }),
                  "Logged.",
                )
              }
            >
              Log it
            </button>
          </div>
          <div className="card">
            {activities.length === 0 ? (
              <p className="muted">No activities yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Type</th>
                    <th>Details</th>
                    <th>Follow-up</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {activities.map((a) => (
                    <tr key={a.id} style={a.done ? { opacity: 0.55 } : undefined}>
                      <td>{a.contact_name}</td>
                      <td>
                        <span className="pill sent">{a.kind}</span>
                      </td>
                      <td>{a.body}</td>
                      <td className="muted">
                        {a.due_date ? d10(a.due_date) : "—"}
                      </td>
                      <td>
                        {!a.done && a.due_date && (
                          <button
                            type="button"
                            className="secondary"
                            style={{ marginTop: 0, padding: "4px 12px" }}
                            onClick={() =>
                              void act(() =>
                                api(
                                  `/tenants/current/crm/activities/${a.id}/done`,
                                  { method: "POST" },
                                ),
                              )
                            }
                          >
                            Done
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
