"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  cost_cents: string;
  price_cents: string;
}
interface Level {
  itemId: string;
  sku: string;
  name: string;
  onHand: number;
}
interface Branch {
  id: string;
  name: string;
}

export default function InventoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [costKes, setCostKes] = useState("");
  const [priceKes, setPriceKes] = useState("");
  const [receive, setReceive] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [i, l, b] = await Promise.all([
      api<Item[]>("/tenants/current/items"),
      api<Level[]>("/tenants/current/stock/levels"),
      api<Branch[]>("/tenants/current/branches"),
    ]);
    setItems(i);
    setLevels(l);
    setBranches(b);
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const act = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const addItem = act(async () => {
    await api("/tenants/current/items", {
      method: "POST",
      body: {
        sku,
        name,
        costCents: Math.round(Number(costKes || "0") * 100),
        priceCents: Math.round(Number(priceKes || "0") * 100),
      },
    });
    setSku(""); setName(""); setCostKes(""); setPriceKes("");
  });

  const receiveStock = (itemId: string) =>
    act(async () => {
      const qty = Number(receive[itemId]);
      if (!(qty > 0)) throw new Error("Enter a quantity to receive");
      if (!branches[0]) throw new Error("Create a branch first (issue an invoice once)");
      await api("/tenants/current/stock/movements", {
        method: "POST",
        body: {
          itemId,
          branchId: branches[0].id,
          qtyDelta: qty,
          reason: "purchase",
        },
      });
      setReceive((s) => ({ ...s, [itemId]: "" }));
    });

  const onHand = (itemId: string): number =>
    levels.filter((l) => l.itemId === itemId).reduce((s, l) => s + l.onHand, 0);

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Inventory</h1>
      {error && <div className="err">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New item</h2>
        <div className="row">
          <div><label>SKU</label><input value={sku} onChange={(e) => setSku(e.target.value)} /></div>
          <div style={{ flex: 2 }}><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label>Cost (KES)</label><input type="number" step="0.01" value={costKes} onChange={(e) => setCostKes(e.target.value)} /></div>
          <div><label>Price (KES)</label><input type="number" step="0.01" value={priceKes} onChange={(e) => setPriceKes(e.target.value)} /></div>
        </div>
        <button disabled={busy || !sku || !name} onClick={() => void addItem()}>Add item</button>
      </div>

      <div className="card">
        {items.length === 0 ? (
          <p className="muted">No items yet. Add your products above — sales will track stock and cost automatically.</p>
        ) : (
          <table>
            <thead>
              <tr><th>SKU</th><th>Name</th><th>Cost</th><th>Price</th><th>On hand</th><th>Receive stock</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.sku}</td>
                  <td>{i.name}</td>
                  <td>{fmtKes(i.cost_cents)}</td>
                  <td>{fmtKes(i.price_cents)}</td>
                  <td><strong>{onHand(i.id)}</strong> {i.unit}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <input
                        type="number"
                        min="0.001"
                        step="any"
                        style={{ maxWidth: 90 }}
                        value={receive[i.id] ?? ""}
                        onChange={(e) => setReceive((s) => ({ ...s, [i.id]: e.target.value }))}
                      />
                      <button className="secondary" disabled={busy} onClick={() => void receiveStock(i.id)()}>
                        Receive
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
