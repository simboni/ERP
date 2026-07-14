"use client";

/**
 * Minimal API client for the Jenga API. Tokens live in sessionStorage for
 * v0 (httpOnly-cookie session lands with the BFF hardening pass).
 */
/**
 * SINGLE-ORIGIN architecture: in production the API serves this app, so
 * the base is simply "" (same origin) — no discovery, no CORS, nothing to
 * misconfigure. Explicit NEXT_PUBLIC_API_URL still wins; the two-port
 * local dev setup (web :3001, api :3000) is auto-detected.
 */
export function getApiBaseSync(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined") {
    if (window.location.port === "3001") return "http://localhost:3000"; // dev
    return ""; // same origin
  }
  return "http://localhost:3000";
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/** Async signature kept for existing call sites. */
export async function getApiBase(): Promise<string> {
  return getApiBaseSync();
}

export function getUserToken(): string | null {
  return sessionStorage.getItem("jenga.userToken");
}
export function getTenantToken(): string | null {
  return sessionStorage.getItem("jenga.tenantToken");
}
export function setUserToken(t: string): void {
  sessionStorage.setItem("jenga.userToken", t);
}
export function setTenantToken(t: string): void {
  sessionStorage.setItem("jenga.tenantToken", t);
}
export function clearTokens(): void {
  sessionStorage.removeItem("jenga.userToken");
  sessionStorage.removeItem("jenga.tenantToken");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const token = opts.token ?? getTenantToken() ?? getUserToken();
  const base = getApiBaseSync();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(
      0,
      "Cannot reach the server. If this was just deployed, the API may still be starting — try again in a minute.",
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data?.message)
      ? data.message.join(", ")
      : (data?.message ?? `HTTP ${res.status}`);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export function fmtKes(cents: number | string): string {
  const n = Number(cents) / 100;
  return `KES ${n.toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;
}
