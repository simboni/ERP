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
export function getRefreshToken(): string | null {
  return sessionStorage.getItem("jenga.refreshToken");
}
export function setRefreshToken(t: string): void {
  sessionStorage.setItem("jenga.refreshToken", t);
}
export function getTenantId(): string | null {
  return sessionStorage.getItem("jenga.tenantId");
}
export function setTenantId(id: string): void {
  sessionStorage.setItem("jenga.tenantId", id);
}
export function clearTokens(): void {
  sessionStorage.removeItem("jenga.userToken");
  sessionStorage.removeItem("jenga.tenantToken");
  sessionStorage.removeItem("jenga.refreshToken");
  sessionStorage.removeItem("jenga.tenantId");
}

/**
 * Silent session renewal: exchange the (rotating) refresh token for a new
 * user token, then re-mint the tenant token. Single-flight so parallel
 * 401s trigger exactly one refresh. Returns false when the session is
 * truly over (refresh token expired/revoked).
 */
let renewal: Promise<boolean> | null = null;
async function renewSession(): Promise<boolean> {
  renewal ??= (async () => {
    const rt = getRefreshToken();
    if (!rt) return false;
    try {
      const base = getApiBaseSync();
      const res = await fetch(`${base}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      setUserToken(data.accessToken);
      setRefreshToken(data.refreshToken);
      const tenantId = getTenantId();
      if (tenantId) {
        const tres = await fetch(`${base}/auth/tenant-token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.accessToken}`,
          },
          body: JSON.stringify({ tenantId }),
        });
        if (!tres.ok) return false;
        const tdata = (await tres.json()) as { accessToken: string };
        setTenantToken(tdata.accessToken);
      }
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        renewal = null;
      }, 0);
    }
  })();
  return renewal;
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
  isRetry = false,
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
  // Access tokens are short-lived by design; renew silently and retry
  // once instead of surfacing "expired token" to the user mid-task.
  if (
    res.status === 401 &&
    !isRetry &&
    !path.startsWith("/auth/") &&
    !opts.token
  ) {
    if (await renewSession()) return api<T>(path, opts, true);
    clearTokens();
    if (typeof window !== "undefined") window.location.href = "/";
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
