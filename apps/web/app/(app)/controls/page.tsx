"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { Column, DataTable } from "@/components/DataTable";

type Tab = "approvals" | "policies" | "audit";
type DocType = "bill_payment" | "purchase_order";

interface ApprovalRow {
  id: string;
  doc_type: DocType;
  doc_id: string;
  amount_cents: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  requested_by_name: string;
  decided_by_name: string | null;
  supplier_name: string | null;
  supplier_invoice_no: string | null;
  po_no: number | null;
}
interface PolicyRow {
  doc_type: DocType;
  threshold_cents: string;
  active: boolean;
}
interface AuditRow {
  id: number;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  payload: unknown;
  actor: string | null;
}
interface AuditPage {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

const DOC_TYPES: [DocType, string][] = [
  ["bill_payment", "Bill payments"],
  ["purchase_order", "Purchase orders"],
];

const docLabel = (r: ApprovalRow): string =>
  r.doc_type === "bill_payment"
    ? `Bill ${r.supplier_invoice_no ?? r.doc_id.slice(0, 8)}`
    : `PO #${r.po_no ?? r.doc_id.slice(0, 8)}`;

/** Role from the tenant JWT — gates the action buttons client-side only. */
function tenantRole(): string {
  try {
    const t = getTenantToken();
    if (!t) return "";
    const claims = JSON.parse(atob(t.split(".")[1])) as { rol?: string };
    return claims.rol ?? "";
  } catch {
    return "";
  }
}

const AUDIT_PAGE = 50;

export default function ControlsPage() {
  const [tab, setTab] = useState<Tab>("approvals");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [role, setRole] = useState("");
  useEffect(() => setRole(tenantRole()), []);
  const isOwner = role === "owner";
  const isApprover = role === "owner" || role === "admin";

  // Approvals
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Policies
  const [policyDraft, setPolicyDraft] = useState<
    Record<DocType, { thresholdKes: string; active: boolean }>
  >({
    bill_payment: { thresholdKes: "", active: true },
    purchase_order: { thresholdKes: "", active: true },
  });
  const [policiesLoaded, setPoliciesLoaded] = useState(false);

  // Audit trail (server-paginated)
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [aAction, setAAction] = useState("");
  const [aEntity, setAEntity] = useState("");
  const [aFrom, setAFrom] = useState("");
  const [aTo, setATo] = useState("");
  const [actionOptions, setActionOptions] = useState<string[]>([]);
  const [entityOptions, setEntityOptions] = useState<string[]>([]);

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "Request failed");

  const loadApprovals = useCallback(async () => {
    setError("");
    try {
      setApprovals(
        await api<ApprovalRow[]>("/tenants/current/controls/approvals"),
      );
    } catch (e) {
      fail(e);
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    setError("");
    try {
      const rows = await api<PolicyRow[]>("/tenants/current/controls/policies");
      setPolicyDraft((prev) => {
        const next = { ...prev };
        for (const p of rows) {
          next[p.doc_type] = {
            thresholdKes: String(Number(p.threshold_cents) / 100),
            active: p.active,
          };
        }
        return next;
      });
      setPoliciesLoaded(true);
    } catch (e) {
      fail(e);
    }
  }, []);

  const loadAudit = useCallback(
    async (offset: number) => {
      setError("");
      try {
        const params = new URLSearchParams({
          limit: String(AUDIT_PAGE),
          offset: String(offset),
        });
        if (aAction) params.set("action", aAction);
        if (aEntity) params.set("entityType", aEntity);
        if (aFrom) params.set("from", aFrom);
        if (aTo) params.set("to", aTo);
        setAudit(
          await api<AuditPage>(`/tenants/current/audit-log?${params}`),
        );
        if (actionOptions.length === 0) {
          const opts = await api<{ actions: string[]; entityTypes: string[] }>(
            "/tenants/current/audit-log/actions",
          );
          setActionOptions(opts.actions);
          setEntityOptions(opts.entityTypes);
        }
      } catch (e) {
        fail(e);
      }
    },
    [aAction, aEntity, aFrom, aTo, actionOptions.length],
  );

  useEffect(() => {
    void loadApprovals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (next: Tab): void => {
    setTab(next);
    setError("");
    setNotice("");
    if (next === "approvals") void loadApprovals();
    if (next === "policies" && !policiesLoaded) void loadPolicies();
    if (next === "audit" && !audit) void loadAudit(0);
  };

  // ---- Approvals actions ----------------------------------------------------

  const decide = async (
    id: string,
    approve: boolean,
    reason?: string,
  ): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/controls/approvals/${id}/decide`, {
        method: "POST",
        body: { approve, ...(reason ? { reason } : {}) },
      });
      setNotice(approve ? "Request approved." : "Request rejected.");
      setRejectingId(null);
      setRejectReason("");
      await loadApprovals();
    } catch (e) {
      fail(e);
    }
  };

  // ---- Policies actions -----------------------------------------------------

  const savePolicy = async (docType: DocType): Promise<void> => {
    setError("");
    setNotice("");
    const draft = policyDraft[docType];
    const kes = Number(draft.thresholdKes);
    if (!Number.isFinite(kes) || kes < 0) {
      setError("Enter a non-negative threshold in KES.");
      return;
    }
    try {
      await api("/tenants/current/controls/policies", {
        method: "PUT",
        body: {
          docType,
          thresholdCents: Math.round(kes * 100),
          active: draft.active,
        },
      });
      setNotice("Policy saved.");
      await loadPolicies();
    } catch (e) {
      fail(e);
    }
  };

  // ---- Columns ----------------------------------------------------------------

  const baseCols: Column<ApprovalRow>[] = [
    {
      key: "created_at",
      label: "Requested",
      value: (r) => r.created_at,
      render: (r) => String(r.created_at).slice(0, 10),
    },
    {
      key: "doc_type",
      label: "Type",
      render: (r) => (
        <span className="pill">
          {r.doc_type === "bill_payment" ? "Bill payment" : "PO send"}
        </span>
      ),
    },
    {
      key: "supplier_name",
      label: "Document",
      value: (r) => `${r.supplier_name ?? ""} ${docLabel(r)}`,
      render: (r) => (
        <>
          {r.supplier_name ?? "—"}{" "}
          <span className="muted">· {docLabel(r)}</span>
        </>
      ),
    },
    { key: "requested_by_name", label: "Requested by" },
    {
      key: "amount_cents",
      label: "Amount",
      num: true,
      value: (r) => Number(r.amount_cents),
      render: (r) => fmtKes(r.amount_cents),
    },
  ];

  const pendingCols: Column<ApprovalRow>[] = [
    ...baseCols,
    {
      key: "actions",
      label: "",
      render: (r) =>
        !isApprover ? null : rejectingId === r.id ? (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <input
              placeholder="Reason…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button
              type="button"
              className="secondary dt-btn"
              disabled={!rejectReason.trim()}
              onClick={() => void decide(r.id, false, rejectReason.trim())}
            >
              Confirm reject
            </button>
            <button
              type="button"
              className="secondary dt-btn"
              onClick={() => {
                setRejectingId(null);
                setRejectReason("");
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="dt-btn"
              onClick={() => void decide(r.id, true)}
            >
              Approve
            </button>{" "}
            <button
              type="button"
              className="secondary dt-btn"
              onClick={() => {
                setRejectingId(r.id);
                setRejectReason("");
              }}
            >
              Reject
            </button>
          </>
        ),
    },
  ];

  const historyCols: Column<ApprovalRow>[] = [
    ...baseCols,
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span className={`pill ${r.status === "approved" ? "paid" : "overdue"}`}>
          {r.status}
        </span>
      ),
    },
    {
      key: "decided_by_name",
      label: "Decided by",
      render: (r) => (
        <>
          {r.decided_by_name ?? "—"}
          {r.reason ? <span className="muted"> — {r.reason}</span> : null}
        </>
      ),
    },
  ];

  const pending = approvals.filter((r) => r.status === "pending");
  const history = approvals.filter((r) => r.status !== "pending");

  const auditOffset = audit?.offset ?? 0;
  const auditHasNext = audit ? audit.offset + audit.rows.length < audit.total : false;

  return (
    <>
      <h1>Controls</h1>
      <div className="tabs">
        {(
          [
            ["approvals", "Approvals"],
            ["policies", "Policies"],
            ["audit", "Audit trail"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {notice && <p className="muted">{notice}</p>}

      {tab === "approvals" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Waiting for approval</h3>
            </div>
            <DataTable
              rows={pending}
              columns={pendingCols}
              searchKeys={["supplier_name", "requested_by_name"]}
              csvName="pending-approvals"
              empty={<p className="muted">Nothing waiting for approval.</p>}
            />
            {!isApprover && pending.length > 0 && (
              <p className="muted">
                Only an owner or admin (other than the requester) can decide
                these.
              </p>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h3>History</h3>
            </div>
            <DataTable
              rows={history}
              columns={historyCols}
              searchKeys={["supplier_name", "requested_by_name"]}
              csvName="approval-history"
              empty={<p className="muted">No decisions yet.</p>}
            />
          </div>
        </>
      )}

      {tab === "policies" && (
        <>
          {!isOwner && (
            <p className="muted">
              Only the owner can change approval thresholds — shown read-only.
            </p>
          )}
          {DOC_TYPES.map(([docType, label]) => (
            <div className="card" key={docType}>
              <div className="card-head">
                <h3>{label}</h3>
              </div>
              <p className="muted">
                {docType === "bill_payment"
                  ? "Bill payments at or above this amount need a second pair of eyes before money leaves."
                  : "Purchase orders at or above this amount need approval before they are sent to the supplier."}
              </p>
              <div className="row">
                <div>
                  <label>Threshold (KES)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    disabled={!isOwner}
                    value={policyDraft[docType].thresholdKes}
                    onChange={(e) =>
                      setPolicyDraft((p) => ({
                        ...p,
                        [docType]: {
                          ...p[docType],
                          thresholdKes: e.target.value,
                        },
                      }))
                    }
                  />
                </div>
                <div>
                  <label>Active</label>
                  <select
                    disabled={!isOwner}
                    value={policyDraft[docType].active ? "yes" : "no"}
                    onChange={(e) =>
                      setPolicyDraft((p) => ({
                        ...p,
                        [docType]: {
                          ...p[docType],
                          active: e.target.value === "yes",
                        },
                      }))
                    }
                  >
                    <option value="yes">Active</option>
                    <option value="no">Off</option>
                  </select>
                </div>
                {isOwner && (
                  <div>
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      disabled={policyDraft[docType].thresholdKes === ""}
                      onClick={() => void savePolicy(docType)}
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === "audit" && (
        <div className="card">
          <div className="card-head">
            <h3>Audit trail</h3>
          </div>
          <div className="dt-toolbar">
            <select value={aAction} onChange={(e) => setAAction(e.target.value)}>
              <option value="">All actions</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select value={aEntity} onChange={(e) => setAEntity(e.target.value)}>
              <option value="">All entities</option>
              {entityOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={aFrom}
              onChange={(e) => setAFrom(e.target.value)}
            />
            <input
              type="date"
              value={aTo}
              onChange={(e) => setATo(e.target.value)}
            />
            <button
              type="button"
              className="secondary dt-btn"
              onClick={() => void loadAudit(0)}
            >
              Apply
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {!audit || audit.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No audit entries match these filters.
                    </td>
                  </tr>
                ) : (
                  audit.rows.map((r) => {
                    const details = JSON.stringify(r.payload ?? {});
                    return (
                      <tr key={r.id}>
                        <td>{new Date(r.created_at).toLocaleString()}</td>
                        <td>{r.actor ?? "system"}</td>
                        <td>
                          <span className="pill">{r.action}</span>
                        </td>
                        <td>
                          {r.entity_type}
                          {r.entity_id ? (
                            <span className="muted">
                              {" "}
                              · {String(r.entity_id).slice(0, 8)}
                            </span>
                          ) : null}
                        </td>
                        <td title={details}>
                          {details.length > 80
                            ? `${details.slice(0, 80)}…`
                            : details}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="dt-pager">
            <span className="muted">
              {audit && audit.total > 0
                ? `${auditOffset + 1}–${auditOffset + audit.rows.length} of ${audit.total}`
                : "0 entries"}
            </span>
            <span className="dt-spacer" />
            <button
              type="button"
              className="secondary dt-btn"
              disabled={auditOffset === 0}
              onClick={() => void loadAudit(Math.max(0, auditOffset - AUDIT_PAGE))}
            >
              ← Prev
            </button>
            <button
              type="button"
              className="secondary dt-btn"
              disabled={!auditHasNext}
              onClick={() => void loadAudit(auditOffset + AUDIT_PAGE)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
