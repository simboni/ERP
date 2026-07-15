"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { ConfirmButton } from "@/components/ConfirmButton";
import { DataTable } from "@/components/DataTable";

interface PoRow {
  id: string;
  po_no: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  total_cents: string;
  bill_id: string | null;
  supplier_name: string;
  qty_ordered: string;
  qty_received: string;
}
interface PoDetail extends PoRow {
  lines: {
    id: string;
    description: string;
    quantity: string;
    qty_received: string;
  }[];
}
interface Item {
  id: string;
  sku: string;
  name: string;
  cost_cents: string;
}
interface Supplier {
  id: string;
  name: string;
}
interface LowRow {
  item_id: string;
  sku: string;
  name: string;
  on_hand: number;
  reorder_level: number;
  on_order: number;
  shortfall: number;
}
interface NewLine {
  itemId: string;
  quantity: string;
  costKes: string;
}

type Tab = "orders" | "new" | "lowstock";

export default function PurchaseOrdersPage() {
  const [tab, setTab] = useState<Tab>("orders");
  const [rows, setRows] = useState<PoRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [low, setLow] = useState<LowRow[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  // new PO form
  const [supplierId, setSupplierId] = useState("");
  const [expected, setExpected] = useState("");
  const [lines, setLines] = useState<NewLine[]>([
    { itemId: "", quantity: "1", costKes: "" },
  ]);

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "failed");

  const load = useCallback(() => {
    Promise.all([
      api<PoRow[]>("/tenants/current/purchase-orders"),
      api<Item[]>("/tenants/current/items"),
      api<Supplier[]>("/tenants/current/suppliers"),
      api<LowRow[]>("/tenants/current/stock/low"),
    ])
      .then(([p, i, s, l]) => {
        setRows(p);
        setItems(i);
        setSuppliers(s);
        setLow(l);
        // Supplier page's "Purchase order" action deep-links ?supplier=<id>:
        // preselect them and open the New order tab directly.
        const wanted = new URLSearchParams(window.location.search).get(
          "supplier",
        );
        if (wanted && s.some((x) => x.id === wanted)) {
          setSupplierId(wanted);
          setTab("new");
        }
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

  const receiveAll = async (po: PoRow): Promise<void> => {
    await act(async () => {
      const detail = await api<PoDetail>(
        `/tenants/current/purchase-orders/${po.id}`,
      );
      const receipts = detail.lines
        .map((l) => ({
          lineId: l.id,
          qty: Number(l.quantity) - Number(l.qty_received),
        }))
        .filter((r) => r.qty > 0);
      await api(`/tenants/current/purchase-orders/${po.id}/receive`, {
        method: "POST",
        body: { receipts },
      });
    }, `PO-${po.po_no} received — stock updated.`);
  };

  const lineTotal = (l: NewLine): number =>
    Math.round(Number(l.costKes || 0) * 100) * Number(l.quantity || 0);
  const formTotal = lines.reduce((s, l) => s + lineTotal(l), 0);

  const prefillReorder = (r: LowRow): void => {
    const item = items.find((i) => i.id === r.item_id);
    setLines([
      {
        itemId: r.item_id,
        quantity: String(Math.max(1, Math.ceil(r.shortfall))),
        costKes: item ? String(Number(item.cost_cents) / 100) : "",
      },
    ]);
    setTab("new");
  };

  const statusPill = (s: string): string =>
    s === "received"
      ? "paid"
      : s === "sent"
        ? "issued"
        : s === "cancelled"
          ? "void"
          : s;

  return (
    <>
      <h1>Purchase orders</h1>
      <div className="tabs">
        {(
          [
            ["orders", `Orders (${rows.length})`],
            ["new", "New PO"],
            ["lowstock", `Low stock (${low.length})`],
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

      {tab === "orders" && (
        <div className="card">
          <DataTable
            rows={rows}
            csvName="purchase-orders"
            searchKeys={["po_no", "supplier_name", "status"]}
            pageSizeDefault={25}
            empty={
              <div className="empty">
                <span className="empty-icon">📦</span>
                <p>No purchase orders yet — raise the first one.</p>
                <button type="button" onClick={() => setTab("new")}>
                  New PO
                </button>
              </div>
            }
            columns={[
              {
                key: "po_no",
                label: "PO #",
                value: (r) => Number(r.po_no),
                render: (r) => <strong>PO-{r.po_no}</strong>,
              },
              { key: "supplier_name", label: "Supplier" },
              {
                key: "order_date",
                label: "Date",
                value: (r) => r.order_date ?? "",
                render: (r) => (
                  <span className="muted">{r.order_date?.slice(0, 10)}</span>
                ),
              },
              {
                key: "total_cents",
                label: "Total",
                num: true,
                value: (r) => Number(r.total_cents),
                render: (r) => fmtKes(r.total_cents),
              },
              {
                key: "progress",
                label: "Received",
                num: true,
                value: (r) => Number(r.qty_received),
                render: (r) => (
                  <span className="kes">
                    {Number(r.qty_received)}/{Number(r.qty_ordered)}
                  </span>
                ),
              },
              {
                key: "status",
                label: "Status",
                render: (r) => (
                  <span className={`pill ${statusPill(r.status)}`}>
                    {r.status}
                  </span>
                ),
              },
              {
                key: "actions",
                label: "",
                render: (r) => (
                  <span style={{ whiteSpace: "nowrap" }}>
                    {r.status === "draft" && (
                      <>
                        <button
                          type="button"
                          className="dt-btn"
                          style={{ marginTop: 0 }}
                          onClick={() =>
                            void act(
                              () =>
                                api(
                                  `/tenants/current/purchase-orders/${r.id}/send`,
                                  { method: "POST" },
                                ),
                              `PO-${r.po_no} sent to supplier.`,
                            )
                          }
                        >
                          Send
                        </button>{" "}
                      </>
                    )}
                    {r.status === "sent" && (
                      <>
                        <button
                          type="button"
                          className="dt-btn"
                          style={{ marginTop: 0 }}
                          onClick={() => void receiveAll(r)}
                        >
                          Receive all
                        </button>{" "}
                      </>
                    )}
                    {["sent", "received"].includes(r.status) &&
                      (r.bill_id ? (
                        <span className="muted">billed</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary dt-btn"
                          style={{ marginTop: 0 }}
                          onClick={() =>
                            void act(
                              () =>
                                api(
                                  `/tenants/current/purchase-orders/${r.id}/convert-to-bill`,
                                  { method: "POST", body: {} },
                                ),
                              `Draft bill created from PO-${r.po_no} — see Purchases.`,
                            )
                          }
                        >
                          Bill
                        </button>
                      ))}
                    {["draft", "sent"].includes(r.status) &&
                      Number(r.qty_received) === 0 && (
                        <>
                          {" "}
                          <ConfirmButton
                            className="secondary dt-btn"
                            style={{ marginTop: 0 }}
                            onConfirm={() =>
                              void act(
                                () =>
                                  api(
                                    `/tenants/current/purchase-orders/${r.id}/cancel`,
                                    { method: "POST" },
                                  ),
                                `PO-${r.po_no} cancelled.`,
                              )
                            }
                          >
                            Cancel
                          </ConfirmButton>
                        </>
                      )}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}

      {tab === "new" && (
        <div className="card">
          <div className="card-head">
            <h3>New purchase order</h3>
          </div>
          <div className="row">
            <div>
              <label>Supplier</label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Select…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Expected delivery</label>
              <input
                type="date"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </div>
          </div>

          {lines.map((l, idx) => (
            <div className="row" key={idx} style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 2 }}>
                <label>Item</label>
                <select
                  value={l.itemId}
                  onChange={(e) => {
                    const item = items.find((i) => i.id === e.target.value);
                    setLines((ls) =>
                      ls.map((x, i) =>
                        i === idx
                          ? {
                              ...x,
                              itemId: e.target.value,
                              costKes: item
                                ? String(Number(item.cost_cents) / 100)
                                : x.costKes,
                            }
                          : x,
                      ),
                    );
                  }}
                >
                  <option value="">Select…</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.sku} — {i.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Qty</label>
                <input
                  type="number"
                  value={l.quantity}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((x, i) =>
                        i === idx ? { ...x, quantity: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
              <div>
                <label>Unit cost (KES)</label>
                <input
                  type="number"
                  value={l.costKes}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((x, i) =>
                        i === idx ? { ...x, costKes: e.target.value } : x,
                      ),
                    )
                  }
                />
              </div>
              <div style={{ flex: 0, minWidth: 90 }}>
                <span className="kes muted">{fmtKes(lineTotal(l))}</span>
              </div>
            </div>
          ))}
          <div className="quick-actions">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setLines((ls) => [
                  ...ls,
                  { itemId: "", quantity: "1", costKes: "" },
                ])
              }
            >
              + Add line
            </button>
          </div>
          <div className="pos-total">
            <span>Total (net)</span>
            <span className="stat">{fmtKes(formTotal)}</span>
          </div>
          <button
            disabled={
              !supplierId ||
              lines.every((l) => !l.itemId || Number(l.quantity) <= 0)
            }
            onClick={() =>
              void act(async () => {
                await api("/tenants/current/purchase-orders", {
                  method: "POST",
                  body: {
                    supplierId,
                    expectedDate: expected || undefined,
                    lines: lines
                      .filter((l) => l.itemId && Number(l.quantity) > 0)
                      .map((l) => ({
                        itemId: l.itemId,
                        quantity: Number(l.quantity),
                        unitCostCents: Math.round(Number(l.costKes || 0) * 100),
                      })),
                  },
                });
                setLines([{ itemId: "", quantity: "1", costKes: "" }]);
                setTab("orders");
              }, "Purchase order drafted.")
            }
          >
            Create PO
          </button>
        </div>
      )}

      {tab === "lowstock" && (
        <>
          <div className="tiles">
            <div className="tile tile-1">
              <div className="tile-value">{low.length}</div>
              <div className="tile-label">Items below reorder</div>
            </div>
            <div className="tile tile-2">
              <div className="tile-value">
                {low.reduce((s, r) => s + r.shortfall, 0)}
              </div>
              <div className="tile-label">Units short</div>
            </div>
            <div className="tile tile-3">
              <div className="tile-value">
                {low.reduce((s, r) => s + r.on_order, 0)}
              </div>
              <div className="tile-label">Already on order</div>
            </div>
          </div>
          <div className="card">
            <DataTable
              rows={low}
              csvName="low-stock"
              searchKeys={["sku", "name"]}
              empty={
                <div className="empty">
                  <span className="empty-icon">✅</span>
                  <p>
                    No items below their reorder level. Set reorder levels on
                    the Inventory page.
                  </p>
                </div>
              }
              columns={[
                { key: "sku", label: "SKU" },
                { key: "name", label: "Item" },
                { key: "on_hand", label: "On hand", num: true },
                { key: "reorder_level", label: "Reorder at", num: true },
                { key: "on_order", label: "On order", num: true },
                {
                  key: "shortfall",
                  label: "Shortfall",
                  num: true,
                  render: (r) =>
                    r.on_order < r.shortfall ? (
                      <strong className="err">{r.shortfall}</strong>
                    ) : (
                      r.shortfall
                    ),
                },
                {
                  key: "actions",
                  label: "",
                  render: (r) => (
                    <button
                      type="button"
                      className="dt-btn"
                      style={{ marginTop: 0 }}
                      onClick={() => prefillReorder(r)}
                    >
                      Reorder
                    </button>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}
    </>
  );
}
