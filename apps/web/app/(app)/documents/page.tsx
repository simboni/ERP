"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getApiBaseSync, getTenantToken } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

interface Doc {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  entity_type: string | null;
  created_at: string;
  uploaded_by: string | null;
}

const fmtSize = (b: number): string =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<Doc[]>("/tenants/current/documents")
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (): Promise<void> => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Max file size is 5MB.");
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const view = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < view.length; i += chunk) {
        binary += String.fromCharCode(...view.subarray(i, i + chunk));
      }
      await api("/tenants/current/documents", {
        method: "POST",
        body: {
          name: file.name,
          mime: file.type || "application/octet-stream",
          dataBase64: btoa(binary),
        },
      });
      setMsg(`Uploaded ${file.name}.`);
      if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const download = (d: Doc): void => {
    void fetch(
      `${getApiBaseSync()}/tenants/current/documents/${d.id}/download`,
      { headers: { Authorization: `Bearer ${getTenantToken()}` } },
    )
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = d.name;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  };

  return (
    <>
      <h1>Documents</h1>
      {error && <div className="err">{error}</div>}
      {msg && <p className="muted">{msg}</p>}

      <div className="card">
        <div className="card-head">
          <h3>Upload</h3>
        </div>
        <p className="muted">
          Contracts, LPOs, delivery notes, KRA letters — up to 5MB each.
          Everything is stored inside your workspace and covered by the same
          tenant isolation as your books.
        </p>
        <input type="file" ref={fileRef} />
        <button disabled={busy} onClick={() => void upload()}>
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Library ({docs.length})</h3>
        </div>
        <DataTable
          rows={docs}
          csvName="documents"
          searchKeys={["name", "entity_type", "uploaded_by"]}
          empty={
            <div className="empty">
              <span className="empty-icon">📂</span>
              <p>No documents yet — upload the first one above.</p>
            </div>
          }
          columns={[
            {
              key: "name",
              label: "Name",
              render: (d) => (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    download(d);
                  }}
                >
                  {d.name}
                </a>
              ),
            },
            {
              key: "size_bytes",
              label: "Size",
              num: true,
              render: (d) => fmtSize(d.size_bytes),
            },
            {
              key: "entity_type",
              label: "Attached to",
              render: (d) =>
                d.entity_type ? (
                  <span className="pill sent">{d.entity_type}</span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            { key: "uploaded_by", label: "By" },
            {
              key: "created_at",
              label: "Date",
              value: (d) => d.created_at,
              render: (d) => d.created_at.slice(0, 10),
            },
          ]}
        />
      </div>
    </>
  );
}
