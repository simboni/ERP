"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtKes } from "@/lib/api";

interface Item {
  id: string;
  sku: string;
  name: string;
  price_cents: string;
  cost_cents?: string;
  vat_rate: string;
  track_stock: boolean;
  active?: boolean;
  reorder_level?: string;
}
interface SaleRow {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  customer_name: string;
  issue_date: string | null;
}
type Tab = "sell" | "items" | "today";
interface StockLevel {
  item_id: string;
  qty: string;
}
interface Branch {
  id: string;
  name: string;
}
interface CartLine {
  item: Item;
  quantity: number;
}
interface SaleResult {
  invoiceId: string;
  invoiceNo: number;
  totalCents: number;
  subtotalCents: number;
  vatCents: number;
  paid: boolean;
  changeCents: number;
  lines: { description: string; quantity: number; unitPriceCents: number }[];
}

export default function PosPage() {
  const [tab, setTab] = useState<Tab>("sell");
  const [items, setItems] = useState<Item[]>([]);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [newItem, setNewItem] = useState({ sku: "", name: "", priceKes: "", costKes: "", reorder: "" });
  const [stock, setStock] = useState<Record<string, number>>({});
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payMethod, setPayMethod] = useState<"cash" | "mpesa_stk">("cash");
  const [tendered, setTendered] = useState("");
  const [msisdn, setMsisdn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stkNote, setStkNote] = useState("");
  const [receipt, setReceipt] = useState<SaleResult | null>(null);
  const [tenantName, setTenantName] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = (): void => {
    Promise.all([
      api<Item[]>("/tenants/current/items"),
      api<StockLevel[]>("/tenants/current/stock/levels").catch(
        () => [] as StockLevel[],
      ),
      api<Branch[]>("/tenants/current/branches"),
      api<SaleRow[]>("/tenants/current/invoices").catch(() => [] as SaleRow[]),
    ])
      .then(([its, lvls, brs, inv]) => {
        setItems(its);
        setStock(
          Object.fromEntries(lvls.map((l) => [l.item_id, Number(l.qty)])),
        );
        setBranches(brs);
        setBranchId((b) => b || (brs[0]?.id ?? ""));
        const today = new Date().toISOString().slice(0, 10);
        setSales(inv.filter((i) => i.issue_date?.slice(0, 10) === today));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  };
  useEffect(() => {
    load();
    try {
      setTenantName(sessionStorage.getItem("jenga.tenantName") ?? "");
    } catch {
      /* private mode */
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          i.active !== false &&
          (!q ||
          i.name.toLowerCase().includes(q.toLowerCase()) ||
          i.sku.toLowerCase().includes(q.toLowerCase())),
      ),
    [items, q],
  );

  const add = (item: Item): void => {
    setCart((c) => {
      const found = c.find((l) => l.item.id === item.id);
      return found
        ? c.map((l) =>
            l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l,
          )
        : [...c, { item, quantity: 1 }];
    });
  };
  const setQty = (id: string, qty: number): void => {
    setCart((c) =>
      qty <= 0
        ? c.filter((l) => l.item.id !== id)
        : c.map((l) => (l.item.id === id ? { ...l, quantity: qty } : l)),
    );
  };

  const totalCents = cart.reduce(
    (s, l) => s + Number(l.item.price_cents) * l.quantity,
    0,
  );
  const tenderedCents = Math.round(Number(tendered || 0) * 100);
  const changePreview = tenderedCents - totalCents;

  const charge = async (): Promise<void> => {
    setBusy(true);
    setError("");
    setStkNote("");
    try {
      const sale = await api<SaleResult>("/tenants/current/pos/sales", {
        method: "POST",
        body: {
          branchId,
          payMethod,
          lines: cart.map((l) => ({ itemId: l.item.id, quantity: l.quantity })),
          tenderedCents:
            payMethod === "cash" && tendered ? tenderedCents : undefined,
        },
      });
      if (payMethod === "cash") {
        setReceipt(sale);
        setCart([]);
        setTendered("");
      } else {
        // STK: push, then poll until confirmed.
        setStkNote("Sending M-Pesa prompt to the phone…");
        const stk = await api<{ paymentId: string }>(
          "/tenants/current/payments/stk",
          {
            method: "POST",
            body: {
              amountCents: sale.totalCents,
              msisdn,
              accountRef: String(sale.invoiceNo),
              invoiceId: sale.invoiceId,
            },
          },
        );
        let ticks = 0;
        pollRef.current = setInterval(() => {
          ticks += 1;
          void api<{ state: string; last_error: string | null }>(
            `/tenants/current/payments/${stk.paymentId}`,
          ).then((p) => {
            if (p.state === "confirmed") {
              if (pollRef.current) clearInterval(pollRef.current);
              setReceipt({ ...sale, paid: true });
              setCart([]);
              setStkNote("");
              setBusy(false);
            } else if (p.state === "failed") {
              if (pollRef.current) clearInterval(pollRef.current);
              setStkNote("");
              setError(
                `M-Pesa payment failed${p.last_error ? `: ${p.last_error}` : ""}. Invoice #${sale.invoiceNo} remains open under Invoices.`,
              );
              setBusy(false);
            } else if (ticks > 40) {
              if (pollRef.current) clearInterval(pollRef.current);
              setStkNote("");
              setError(
                `No confirmation yet — invoice #${sale.invoiceNo} stays open and will auto-reconcile when the payment lands.`,
              );
              setBusy(false);
            }
          });
        }, 3000);
        return; // busy stays true while polling
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sale failed");
    }
    setBusy(false);
  };

  if (receipt) {
    return (
      <div className="receipt-wrap">
        <div className="receipt card">
          <h2 style={{ margin: 0, textAlign: "center" }}>{tenantName}</h2>
          <p className="muted" style={{ textAlign: "center", margin: "2px 0 10px" }}>
            SALE RECEIPT · #{receipt.invoiceNo} ·{" "}
            {new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}
          </p>
          <table>
            <tbody>
              {receipt.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.description}
                    <br />
                    <span className="muted">
                      {l.quantity} × {fmtKes(l.unitPriceCents)}
                    </span>
                  </td>
                  <td className="num">
                    {fmtKes(l.unitPriceCents * l.quantity)}
                  </td>
                </tr>
              ))}
              <tr>
                <td>Subtotal</td>
                <td className="num">{fmtKes(receipt.subtotalCents)}</td>
              </tr>
              <tr>
                <td>VAT 16%</td>
                <td className="num">{fmtKes(receipt.vatCents)}</td>
              </tr>
              <tr>
                <td>
                  <strong>TOTAL</strong>
                </td>
                <td className="num">
                  <strong>{fmtKes(receipt.totalCents)}</strong>
                </td>
              </tr>
              {receipt.changeCents > 0 && (
                <tr>
                  <td>Change</td>
                  <td className="num">{fmtKes(receipt.changeCents)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="muted" style={{ textAlign: "center", marginTop: 10 }}>
            {receipt.paid ? "PAID" : "PENDING M-PESA"} · eTIMS invoice — thank
            you / asante
          </p>
        </div>
        <div className="quick-actions no-print" style={{ justifyContent: "center" }}>
          <button type="button" onClick={() => window.print()}>
            🖨 Print receipt
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setReceipt(null)}
          >
            New sale
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <h1>Sell (POS)</h1>
      <div className="tabs">
        {(
          [
            ["sell", "Sell"],
            ["items", `Items (${items.length})`],
            ["today", `Today's sales (${sales.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => {
              setTab(key);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {tab === "sell" && (
      <div className="pos-grid">
        <div>
          <input
            placeholder="Search items or SKU…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="pos-items">
            {filtered.map((i) => {
              const qty = stock[i.id];
              const out = i.track_stock && qty !== undefined && qty <= 0;
              return (
                <button
                  key={i.id}
                  type="button"
                  className="pos-item"
                  disabled={out}
                  onClick={() => add(i)}
                >
                  <span className="pos-item-name">{i.name}</span>
                  <span className="kes">{fmtKes(i.price_cents)}</span>
                  <span className="muted">
                    {out
                      ? "out of stock"
                      : i.track_stock && qty !== undefined
                        ? `${qty} left`
                        : i.sku}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="muted">No items match — add items in Inventory.</p>
            )}
          </div>
        </div>

        <div className="card pos-cart">
          <div className="card-head">
            <h3>Cart ({cart.length})</h3>
          </div>
          {cart.length === 0 ? (
            <p className="muted">Tap items to add them.</p>
          ) : (
            <table>
              <tbody>
                {cart.map((l) => (
                  <tr key={l.item.id}>
                    <td>
                      {l.item.name}
                      <br />
                      <span className="muted">{fmtKes(l.item.price_cents)}</span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="secondary dt-btn"
                        onClick={() => setQty(l.item.id, l.quantity - 1)}
                      >
                        −
                      </button>{" "}
                      {l.quantity}{" "}
                      <button
                        type="button"
                        className="secondary dt-btn"
                        onClick={() => setQty(l.item.id, l.quantity + 1)}
                      >
                        +
                      </button>
                    </td>
                    <td className="num">
                      {fmtKes(Number(l.item.price_cents) * l.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="pos-total">
            <span>Total</span>
            <span className="stat">{fmtKes(totalCents)}</span>
          </div>

          {branches.length > 1 && (
            <>
              <label>Branch</label>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="tabs" style={{ width: "100%" }}>
            <button
              type="button"
              className={payMethod === "cash" ? "tab active" : "tab"}
              onClick={() => setPayMethod("cash")}
              style={{ flex: 1 }}
            >
              💵 Cash
            </button>
            <button
              type="button"
              className={payMethod === "mpesa_stk" ? "tab active" : "tab"}
              onClick={() => setPayMethod("mpesa_stk")}
              style={{ flex: 1 }}
            >
              📱 M-Pesa
            </button>
          </div>

          {payMethod === "cash" ? (
            <>
              <label>Cash received (KES, optional)</label>
              <input
                type="number"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={String(Math.ceil(totalCents / 100))}
              />
              {tendered && changePreview >= 0 && (
                <p className="muted">Change: {fmtKes(changePreview)}</p>
              )}
              {tendered && changePreview < 0 && (
                <p className="err">Short by {fmtKes(-changePreview)}</p>
              )}
            </>
          ) : (
            <>
              <label>Customer phone (M-Pesa)</label>
              <input
                value={msisdn}
                onChange={(e) => setMsisdn(e.target.value)}
                placeholder="+2547…"
              />
            </>
          )}
          {stkNote && <p className="muted">{stkNote}</p>}
          <button
            disabled={
              busy ||
              cart.length === 0 ||
              !branchId ||
              (payMethod === "mpesa_stk" && msisdn.length < 10) ||
              (payMethod === "cash" && !!tendered && changePreview < 0)
            }
            onClick={() => void charge()}
            style={{ width: "100%", padding: "13px", fontSize: "1.05rem" }}
          >
            {busy ? "Processing…" : `Charge ${fmtKes(totalCents)}`}
          </button>
        </div>
      </div>
      )}

      {tab === "items" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Add item</h3>
            </div>
            <div className="row">
              <div>
                <label>SKU</label>
                <input value={newItem.sku} onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })} />
              </div>
              <div style={{ flex: 2 }}>
                <label>Name</label>
                <input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
              </div>
              <div>
                <label>Selling price (KES)</label>
                <input type="number" value={newItem.priceKes} onChange={(e) => setNewItem({ ...newItem, priceKes: e.target.value })} />
              </div>
              <div>
                <label>Cost (KES)</label>
                <input type="number" value={newItem.costKes} onChange={(e) => setNewItem({ ...newItem, costKes: e.target.value })} />
              </div>
              <div>
                <label>Reorder at</label>
                <input type="number" value={newItem.reorder} onChange={(e) => setNewItem({ ...newItem, reorder: e.target.value })} />
              </div>
            </div>
            <button
              disabled={!newItem.sku || !newItem.name}
              onClick={() => {
                setError("");
                api("/tenants/current/items", {
                  method: "POST",
                  body: {
                    sku: newItem.sku,
                    name: newItem.name,
                    priceCents: Math.round(Number(newItem.priceKes || 0) * 100),
                    costCents: Math.round(Number(newItem.costKes || 0) * 100),
                  },
                })
                  .then(async (created: unknown) => {
                    const id = (created as { id: string }).id;
                    if (Number(newItem.reorder) > 0) {
                      await api(`/tenants/current/items/${id}/reorder-level`, {
                        method: "POST",
                        body: { reorderLevel: Number(newItem.reorder) },
                      });
                    }
                    setNewItem({ sku: "", name: "", priceKes: "", costKes: "", reorder: "" });
                    load();
                  })
                  .catch((e) => setError(e instanceof Error ? e.message : "failed"));
              }}
            >
              Add item
            </button>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Catalog</h3>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th className="num">Price (KES)</th>
                    <th className="num">In stock</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} style={i.active === false ? { opacity: 0.5 } : undefined}>
                      <td className="muted">{i.sku}</td>
                      <td>{i.name}</td>
                      <td className="num">
                        <input
                          type="number"
                          defaultValue={Number(i.price_cents) / 100}
                          style={{ maxWidth: 110, padding: "4px 8px", textAlign: "right" }}
                          onBlur={(e) => {
                            const v = Math.round(Number(e.target.value || 0) * 100);
                            if (v !== Number(i.price_cents) && v >= 0) {
                              void api(`/tenants/current/items/${i.id}`, {
                                method: "PATCH",
                                body: { priceCents: v },
                              }).then(load).catch((er) => setError(er instanceof Error ? er.message : "failed"));
                            }
                          }}
                        />
                      </td>
                      <td className="num">{stock[i.id] ?? "—"}</td>
                      <td>
                        <span className={`pill ${i.active === false ? "void" : "paid"}`}>
                          {i.active === false ? "archived" : "active"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary dt-btn"
                          style={{ marginTop: 0 }}
                          onClick={() =>
                            void api(`/tenants/current/items/${i.id}`, {
                              method: "PATCH",
                              body: { active: i.active === false },
                            }).then(load).catch((er) => setError(er instanceof Error ? er.message : "failed"))
                          }
                        >
                          {i.active === false ? "Restore" : "Archive"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Prices save when you click away from the field. Archived items
              disappear from the Sell grid but keep their history.
            </p>
          </div>
        </>
      )}

      {tab === "today" && (
        <div className="card">
          <div className="card-head">
            <h3>Today's sales</h3>
          </div>
          {sales.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">🛒</span>
              <p>No sales yet today — the first one is a tap away.</p>
              <button type="button" onClick={() => setTab("sell")}>Sell</button>
            </div>
          ) : (
            <>
              <div className="pos-total">
                <span>Total today ({sales.length} sales)</span>
                <span className="stat">
                  {fmtKes(sales.reduce((t, sl) => t + Number(sl.total_cents), 0))}
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>No.</th>
                    <th>Customer</th>
                    <th className="num">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sl) => (
                    <tr key={sl.id}>
                      <td>{sl.invoice_no ?? "draft"}</td>
                      <td>{sl.customer_name}</td>
                      <td className="num">{fmtKes(sl.total_cents)}</td>
                      <td><span className={`pill ${sl.status}`}>{sl.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </>
  );
}
