"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Purchase orders merged into the Purchasing workspace (/purchases).
 * This stub keeps old links and bookmarks working.
 */
export default function PurchaseOrdersRedirect() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const supplier = params.get("supplier");
    const target = supplier
      ? `/purchases?tab=newpo&supplier=${supplier}`
      : "/purchases?tab=orders";
    router.replace(target);
  }, [router]);
  return <p className="muted">Opening Purchasing…</p>;
}
