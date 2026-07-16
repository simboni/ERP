"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

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
      router.replace("/login");
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
        <DataTable
          rows={items}
          csvName="inventory"
          searchKeys={["sku", "name"]}
          pageSizeDefault={25}
          empty={
            <p className="muted">
              No items yet. Add your products above — sales will track stock
              and cost automatically.
            </p>
          }
          columns={[
            { key: "sku", label: "SKU" },
            { key: "name", label: "Name" },
            {
              key: "cost_cents",
              label: "Cost",
              num: true,
              value: (i) => Number(i.cost_cents),
              render: (i) => fmtKes(i.cost_cents),
            },
            {
              key: "price_cents",
              label: "Price",
              num: true,
              value: (i) => Number(i.price_cents),
              render: (i) => fmtKes(i.price_cents),
            },
            {
              key: "on_hand",
              label: "On hand",
              num: true,
              value: (i) => onHand(i.id),
              render: (i) => (
                <>
                  <strong>{onHand(i.id)}</strong> {i.unit}
                </>
              ),
            },
            {
              key: "actions",
              label: "Receive stock",
              value: () => "",
              render: (i) => (
                <span className="row" style={{ gap: 6 }}>
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    style={{ maxWidth: 90 }}
                    value={receive[i.id] ?? ""}
                    onChange={(e) =>
                      setReceive((s) => ({ ...s, [i.id]: e.target.value }))
                    }
                  />
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void receiveStock(i.id)()}
                  >
                    Receive
                  </button>
                </span>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
