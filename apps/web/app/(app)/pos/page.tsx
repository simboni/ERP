"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Item {
  id: string;
  sku: string;
  name: string;
  price_cents: string;
  vat_rate: string;
  track_stock: boolean;
}
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
  const [items, setItems] = useState<Item[]>([]);
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

  useEffect(() => {
    Promise.all([
      api<Item[]>("/tenants/current/items"),
      api<StockLevel[]>("/tenants/current/stock/levels").catch(
        () => [] as StockLevel[],
      ),
      api<Branch[]>("/tenants/current/branches"),
    ])
      .then(([its, lvls, brs]) => {
        setItems(its);
        setStock(
          Object.fromEntries(lvls.map((l) => [l.item_id, Number(l.qty)])),
        );
        setBranches(brs);
        if (brs[0]) setBranchId(brs[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "load failed"));
    setTenantName(sessionStorage.getItem("jenga.tenantName") ?? "");
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          !q ||
          i.name.toLowerCase().includes(q.toLowerCase()) ||
          i.sku.toLowerCase().includes(q.toLowerCase()),
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
      <h1>Sell</h1>
      {error && <div className="err">{error}</div>}
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
    </>
  );
}
