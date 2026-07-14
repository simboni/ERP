"use client";

/**
 * Minimal API client for the Jenga API. Tokens live in sessionStorage for
 * v0 (httpOnly-cookie session lands with the BFF hardening pass).
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

let resolvedBase: string | null = process.env.NEXT_PUBLIC_API_URL ?? null;

/**
 * Resolve the API base: build-time value if baked in, else the server's
 * runtime config (survives deploy-order races on Render), else local dev.
 */
export async function getApiBase(): Promise<string> {
  if (resolvedBase) return resolvedBase;
  try {
    const res = await fetch("/api/config");
    const cfg = (await res.json()) as { apiUrl: string | null };
    if (cfg.apiUrl) {
      resolvedBase = cfg.apiUrl;
      return resolvedBase;
    }
  } catch {
    // fall through to local default
  }
  resolvedBase = "http://localhost:3000";
  return resolvedBase;
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
  const base = await getApiBase();
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
