"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getApiBaseSync, getTenantToken } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { SearchSelect } from "@/components/SearchSelect";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useI18n, type TKey } from "@/lib/i18n";

interface Doc {
  id: string;
  name: string;
  mime: string;
  size_bytes: number;
  entity_type: string | null;
  folder_id: string | null;
  category: string;
  tags: string[];
  description: string | null;
  expires_on: string | null;
  created_at: string;
  uploaded_by: string | null;
}

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  doc_count: number;
  child_count: number;
}

interface Summary {
  total_docs: number;
  total_bytes: number;
  expiring_soon: number;
  expired: number;
  folders: number;
  by_category: { category: string; n: number }[];
}

const CATEGORIES = [
  "contract",
  "invoice",
  "receipt",
  "id",
  "license",
  "certificate",
  "report",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

const CAT_KEY: Record<Category, TKey> = {
  contract: "catContract",
  invoice: "catInvoice",
  receipt: "catReceipt",
  id: "catId",
  license: "catLicense",
  certificate: "catCertificate",
  report: "catReport",
  other: "catOther",
};

const CAT_PILL: Record<Category, string> = {
  contract: "issued",
  invoice: "sent",
  receipt: "paid",
  id: "pending",
  license: "approved",
  certificate: "matched",
  report: "converted",
  other: "",
};

const fmtSize = (b: number): string =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;

const daysUntil = (iso: string): number =>
  Math.ceil(
    (new Date(iso + "T00:00:00").getTime() - Date.now()) / 86400_000,
  );

const ROOT = "root";

export default function DocumentsPage() {
  const { t } = useI18n();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // filters
  const [folder, setFolder] = useState<string | null>(null); // null = all
  const [catFilter, setCatFilter] = useState("");
  const [expiringOnly, setExpiringOnly] = useState(false);

  // upload form
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [uCat, setUCat] = useState<Category>("other");
  const [uFolder, setUFolder] = useState<string>("");
  const [uTags, setUTags] = useState("");
  const [uDesc, setUDesc] = useState("");
  const [uExpiry, setUExpiry] = useState("");

  // edit form
  const [editing, setEditing] = useState<Doc | null>(null);
  const [eName, setEName] = useState("");
  const [eCat, setECat] = useState<Category>("other");
  const [eFolder, setEFolder] = useState("");
  const [eTags, setETags] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [eExpiry, setEExpiry] = useState("");

  const catLabel = (c: string): string =>
    CATEGORIES.includes(c as Category) ? t(CAT_KEY[c as Category]) : c;

  const loadFolders = useCallback(() => {
    api<Folder[]>("/tenants/current/documents/folders")
      .then(setFolders)
      .catch(() => undefined);
  }, []);

  const loadSummary = useCallback(() => {
    api<Summary>("/tenants/current/documents/summary")
      .then(setSummary)
      .catch(() => undefined);
  }, []);

  const loadDocs = useCallback(() => {
    const qs = new URLSearchParams();
    if (folder) qs.set("folderId", folder);
    if (catFilter) qs.set("category", catFilter);
    if (expiringOnly) qs.set("expiringInDays", "30");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    api<Doc[]>(`/tenants/current/documents${suffix}`)
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [folder, catFilter, expiringOnly]);

  useEffect(() => {
    loadFolders();
    loadSummary();
  }, [loadFolders, loadSummary]);
  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const refreshAll = (): void => {
    loadDocs();
    loadFolders();
    loadSummary();
  };

  // ---- folder tree ----
  const tree = useMemo(() => {
    const byParent = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const arr = byParent.get(f.parent_id) ?? [];
      arr.push(f);
      byParent.set(f.parent_id, arr);
    }
    const walk = (parent: string | null, depth: number): [Folder, number][] => {
      const out: [Folder, number][] = [];
      for (const f of byParent.get(parent) ?? []) {
        out.push([f, depth]);
        out.push(...walk(f.id, depth + 1));
      }
      return out;
    };
    return walk(null, 0);
  }, [folders]);

  const folderOptions = useMemo(
    () => folders.map((f) => ({ id: f.id, label: f.name })),
    [folders],
  );

  // ---- upload ----
  const toBase64 = async (file: File): Promise<string> => {
    const buf = await file.arrayBuffer();
    let binary = "";
    const view = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode(...view.subarray(i, i + chunk));
    }
    return btoa(binary);
  };

  const upload = async (): Promise<void> => {
    const file = pending ?? fileRef.current?.files?.[0];
    if (!file) {
      setError(t("docChooseFile"));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Max file size is 5MB.");
      return;
    }
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api("/tenants/current/documents", {
        method: "POST",
        body: {
          name: file.name,
          mime: file.type || "application/octet-stream",
          dataBase64: await toBase64(file),
          folderId: uFolder || null,
          category: uCat,
          tags: uTags,
          description: uDesc || null,
          expiresOn: uExpiry || null,
        },
      });
      setMsg(`${t("docUpload")}: ${file.name}`);
      setPending(null);
      setUTags("");
      setUDesc("");
      setUExpiry("");
      if (fileRef.current) fileRef.current.value = "";
      refreshAll();
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

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/tenants/current/documents/${id}`, { method: "DELETE" });
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  // ---- edit metadata ----
  const openEdit = (d: Doc): void => {
    setEditing(d);
    setEName(d.name);
    setECat((d.category as Category) ?? "other");
    setEFolder(d.folder_id ?? "");
    setETags((d.tags ?? []).join(", "));
    setEDesc(d.description ?? "");
    setEExpiry(d.expires_on ? d.expires_on.slice(0, 10) : "");
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tenants/current/documents/${editing.id}`, {
        method: "PATCH",
        body: {
          name: eName,
          category: eCat,
          folderId: eFolder || null,
          tags: eTags,
          description: eDesc || null,
          expiresOn: eExpiry || null,
        },
      });
      setEditing(null);
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  // ---- folder actions ----
  const newFolder = async (): Promise<void> => {
    const name = window.prompt(t("docFolderName"));
    if (!name?.trim()) return;
    try {
      await api("/tenants/current/documents/folders", {
        method: "POST",
        body: { name, parentId: folder && folder !== ROOT ? folder : null },
      });
      loadFolders();
      loadSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : "folder failed");
    }
  };

  const renameFolder = async (f: Folder): Promise<void> => {
    const name = window.prompt(t("docRenameFolder"), f.name);
    if (!name?.trim() || name === f.name) return;
    try {
      await api(`/tenants/current/documents/folders/${f.id}`, {
        method: "PATCH",
        body: { name },
      });
      loadFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "rename failed");
    }
  };

  const deleteFolder = async (f: Folder): Promise<void> => {
    try {
      await api(`/tenants/current/documents/folders/${f.id}`, {
        method: "DELETE",
      });
      if (folder === f.id) setFolder(null);
      loadFolders();
      loadSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("docFolderNotEmpty"));
    }
  };

  const catOptions = (
    <>
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {catLabel(c)}
        </option>
      ))}
    </>
  );

  const tiles = summary
    ? [
        { label: t("docTotalDocs"), value: String(summary.total_docs), cls: "tile-3" },
        { label: t("docTotalSize"), value: fmtSize(summary.total_bytes), cls: "tile-2" },
        {
          label: t("docExpiringSoon"),
          value: String(summary.expiring_soon),
          cls: "tile-1",
          action: () => {
            setExpiringOnly(true);
            setFolder(null);
            setCatFilter("");
          },
        },
        { label: t("docFolderCount"), value: String(summary.folders), cls: "tile-4" },
      ]
    : [];

  return (
    <>
      <h1>{t("docTitle")}</h1>
      <p className="muted" style={{ marginTop: -6 }}>
        {t("docSubtitle")}
      </p>
      {error && <div className="err">{error}</div>}
      {msg && <p className="muted">{msg}</p>}

      {summary && (
        <div className="tiles">
          {tiles.map((tl) => (
            <div
              key={tl.label}
              className={`tile ${tl.cls}`}
              onClick={tl.action}
              style={tl.action ? { cursor: "pointer" } : undefined}
            >
              <div className="tile-value">{tl.value}</div>
              <div className="tile-label">{tl.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Upload */}
      <div className="card">
        <div className="card-head">
          <h3>{t("docUpload")}</h3>
        </div>
        <p className="muted">{t("docUploadHint")}</p>
        <div
          className={dragOver ? "dms-drop over" : "dms-drop"}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) setPending(f);
          }}
        >
          {pending ? (
            <strong>
              {pending.name}{" "}
              <span className="muted">({fmtSize(pending.size)})</span>
            </strong>
          ) : (
            <span className="muted">📎 {t("docDropHere")}</span>
          )}
          <input
            type="file"
            ref={fileRef}
            style={{ display: "none" }}
            onChange={(e) => setPending(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="dms-form-grid">
          <div>
            <label>{t("docFolder")}</label>
            <select value={uFolder} onChange={(e) => setUFolder(e.target.value)}>
              <option value="">{t("docNoFolder")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>{t("docCategory")}</label>
            <select
              value={uCat}
              onChange={(e) => setUCat(e.target.value as Category)}
            >
              {catOptions}
            </select>
          </div>
          <div>
            <label>{t("docTags")}</label>
            <input
              value={uTags}
              onChange={(e) => setUTags(e.target.value)}
              placeholder={t("docTagsHint")}
            />
          </div>
          <div>
            <label>{t("docExpiresOn")}</label>
            <input
              type="date"
              value={uExpiry}
              onChange={(e) => setUExpiry(e.target.value)}
            />
          </div>
          <div className="full">
            <label>{t("docDescription")}</label>
            <input value={uDesc} onChange={(e) => setUDesc(e.target.value)} />
          </div>
        </div>
        <button
          disabled={busy || !pending}
          onClick={() => void upload()}
          style={{ marginTop: 12 }}
        >
          {busy ? t("docUploading") : t("docUpload")}
        </button>
      </div>

      {/* Edit metadata (inline) */}
      {editing && (
        <div className="card">
          <div className="card-head">
            <h3>{t("docEditMeta")}</h3>
          </div>
          <div className="dms-form-grid">
            <div>
              <label>{t("docName")}</label>
              <input value={eName} onChange={(e) => setEName(e.target.value)} />
            </div>
            <div>
              <label>{t("docCategory")}</label>
              <select
                value={eCat}
                onChange={(e) => setECat(e.target.value as Category)}
              >
                {catOptions}
              </select>
            </div>
            <div>
              <label>{t("docFolder")}</label>
              <SearchSelect
                options={[
                  { id: "", label: t("docNoFolder") },
                  ...folderOptions,
                ]}
                value={eFolder}
                onChange={setEFolder}
                placeholder={t("docNoFolder")}
              />
            </div>
            <div>
              <label>{t("docExpiresOn")}</label>
              <input
                type="date"
                value={eExpiry}
                onChange={(e) => setEExpiry(e.target.value)}
              />
            </div>
            <div>
              <label>{t("docTags")}</label>
              <input
                value={eTags}
                onChange={(e) => setETags(e.target.value)}
                placeholder={t("docTagsHint")}
              />
            </div>
            <div className="full">
              <label>{t("docDescription")}</label>
              <input value={eDesc} onChange={(e) => setEDesc(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button disabled={busy} onClick={() => void saveEdit()}>
              {t("docSave")}
            </button>
            <button className="secondary" onClick={() => setEditing(null)}>
              {t("docCancel")}
            </button>
          </div>
        </div>
      )}

      <div className="dms-layout">
        {/* Folder tree */}
        <aside className="card dms-tree">
          <div className="dms-tree-head">
            <h3>{t("docFolders")}</h3>
            <button
              className="secondary dt-btn"
              onClick={() => void newFolder()}
            >
              {t("docNewFolder")}
            </button>
          </div>
          <button
            className={folder === null ? "dms-folder active" : "dms-folder"}
            onClick={() => {
              setFolder(null);
              setExpiringOnly(false);
            }}
          >
            <span>🗂️</span>
            <span className="dms-folder-name">{t("docAllDocuments")}</span>
            <span className="dms-count">{summary?.total_docs ?? ""}</span>
          </button>
          {tree.map(([f, depth]) => (
            <div className="dms-folder-row" key={f.id}>
              <button
                className={folder === f.id ? "dms-folder active" : "dms-folder"}
                style={{ paddingLeft: 10 + depth * 16 }}
                onClick={() => {
                  setFolder(f.id);
                  setExpiringOnly(false);
                }}
              >
                <span>📁</span>
                <span className="dms-folder-name">{f.name}</span>
                <span className="dms-count">{f.doc_count || ""}</span>
              </button>
              <button
                className="dms-fbtn"
                title={t("docRenameFolder")}
                onClick={() => void renameFolder(f)}
              >
                ✎
              </button>
              <ConfirmButton
                className="dms-fbtn"
                title={t("docDeleteFolder")}
                onConfirm={() => void deleteFolder(f)}
              >
                🗑
              </ConfirmButton>
            </div>
          ))}
        </aside>

        {/* Documents */}
        <div className="card">
          <div className="card-head">
            <h3>
              {folder
                ? folders.find((f) => f.id === folder)?.name
                : t("docAllDocuments")}{" "}
              ({docs.length})
            </h3>
          </div>
          {expiringOnly && (
            <p className="muted">
              ⚠ {t("docShowingExpiring")} ·{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setExpiringOnly(false);
                }}
              >
                {t("docClearFilter")}
              </a>
            </p>
          )}
          <DataTable
            rows={docs}
            csvName="documents"
            searchKeys={["name", "description", "category"]}
            toolbar={
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                style={{ width: "auto" }}
              >
                <option value="">{t("docAllCategories")}</option>
                {catOptions}
              </select>
            }
            empty={
              <div className="empty">
                <span className="empty-icon">📂</span>
                <p>{t("docNoDocs")}</p>
              </div>
            }
            columns={[
              {
                key: "name",
                label: t("docName"),
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
                key: "category",
                label: t("docCategory"),
                value: (d) => catLabel(d.category),
                render: (d) => {
                  const pill = CAT_PILL[d.category as Category] ?? "";
                  return (
                    <span className={pill ? `pill ${pill}` : "pill"}>
                      {catLabel(d.category)}
                    </span>
                  );
                },
              },
              {
                key: "tags",
                label: t("docTags"),
                value: (d) => (d.tags ?? []).join(" "),
                render: (d) =>
                  d.tags && d.tags.length ? (
                    <span className="dms-tags">
                      {d.tags.map((tg) => (
                        <span key={tg} className="dms-tag">
                          {tg}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  ),
              },
              {
                key: "size_bytes",
                label: t("docSize"),
                num: true,
                render: (d) => fmtSize(d.size_bytes),
              },
              {
                key: "expires_on",
                label: t("docExpiry"),
                value: (d) => d.expires_on ?? "",
                render: (d) => {
                  if (!d.expires_on) return <span className="muted">—</span>;
                  const left = daysUntil(d.expires_on);
                  const iso = d.expires_on.slice(0, 10);
                  if (left < 0)
                    return (
                      <span className="pill overdue">
                        {t("docExpired")} · {iso}
                      </span>
                    );
                  if (left <= 30)
                    return (
                      <span className="pill pending">⚠ {iso}</span>
                    );
                  return iso;
                },
              },
              {
                key: "created_at",
                label: t("docUploaded"),
                value: (d) => d.created_at,
                render: (d) => d.created_at.slice(0, 10),
              },
              {
                key: "actions",
                label: t("docActions"),
                render: (d) => (
                  <span
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <button
                      className="secondary dt-btn"
                      onClick={() => download(d)}
                    >
                      ⤓
                    </button>
                    <button
                      className="secondary dt-btn"
                      onClick={() => openEdit(d)}
                    >
                      {t("docEdit")}
                    </button>
                    <ConfirmButton
                      className="dt-btn"
                      style={{ background: "var(--danger)", color: "#fff" }}
                      onConfirm={() => void remove(d.id)}
                    >
                      {t("docDelete")}
                    </ConfirmButton>
                  </span>
                ),
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
