"use client";

import { ReactNode, useMemo, useState } from "react";

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  /** Cell renderer; defaults to the raw value. */
  render?: (row: T) => ReactNode;
  /** Value used for sorting and CSV; defaults to row[key]. */
  value?: (row: T) => string | number | null;
}

function cellValue<T>(row: T, col: Column<T>): string | number | null {
  if (col.value) return col.value(row);
  const v = (row as Record<string, unknown>)[col.key];
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v : String(v);
}

/**
 * The platform-wide list: search, click-to-sort columns, pagination and
 * one-click CSV export of exactly what is filtered. Every list screen
 * uses this so data behaves identically everywhere.
 */
export function DataTable<T>({
  rows,
  columns,
  searchKeys,
  csvName,
  pageSizeDefault = 10,
  empty,
  toolbar,
}: {
  rows: T[];
  columns: Column<T>[];
  /** Which columns' values participate in the search box. */
  searchKeys?: string[];
  /** Enables the Export CSV button with this file name. */
  csvName?: string;
  pageSizeDefault?: number;
  empty?: ReactNode;
  /** Extra controls rendered next to the search box (e.g. filters). */
  toolbar?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(pageSizeDefault);

  const searchCols = useMemo(
    () =>
      columns.filter((c) => !searchKeys || searchKeys.includes(c.key)),
    [columns, searchKeys],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = !needle
      ? rows
      : rows.filter((r) =>
          searchCols.some((c) =>
            String(cellValue(r, c) ?? "")
              .toLowerCase()
              .includes(needle),
          ),
        );
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        out = [...out].sort((a, b) => {
          const av = cellValue(a, col);
          const bv = cellValue(b, col);
          if (av === null) return 1;
          if (bv === null) return -1;
          const cmp =
            typeof av === "number" && typeof bv === "number"
              ? av - bv
              : Number(av) - Number(bv) ||
                String(av).localeCompare(String(bv));
          return cmp * sortDir;
        });
      }
    }
    return out;
  }, [rows, q, searchCols, sortKey, sortDir, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const view = filtered.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  const exportCsv = (): void => {
    const lines = [
      columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(","),
      ...filtered.map((r) =>
        columns
          .map((c) => `"${String(cellValue(r, c) ?? "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([lines], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName ?? "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortBy = (key: string): void => {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div>
      <div className="dt-toolbar">
        <input
          placeholder="Search…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          style={{ maxWidth: 260 }}
        />
        {toolbar}
        <span className="dt-spacer" />
        {csvName && filtered.length > 0 && (
          <button
            type="button"
            className="secondary dt-btn"
            onClick={exportCsv}
          >
            ⤓ CSV
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={c.num ? "num" : undefined}
                  onClick={() => sortBy(c.key)}
                  style={{ cursor: "pointer", userSelect: "none" }}
                  title="Sort"
                >
                  {c.label}
                  {sortKey === c.key && (sortDir === 1 ? " ↑" : " ↓")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="muted">
                  Nothing matches “{q}”.
                </td>
              </tr>
            ) : (
              view.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.num ? "num" : undefined}>
                      {c.render ? c.render(r) : (cellValue(r, c) ?? "—")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > pageSize && (
        <div className="dt-pager">
          <span className="muted">
            {safePage * pageSize + 1}–
            {Math.min((safePage + 1) * pageSize, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <span className="dt-spacer" />
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
            style={{ width: "auto", padding: "4px 8px" }}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary dt-btn"
            disabled={safePage === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Prev
          </button>
          <button
            type="button"
            className="secondary dt-btn"
            disabled={safePage >= pages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
