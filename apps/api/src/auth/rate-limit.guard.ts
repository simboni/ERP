import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";

/**
 * Sliding-window rate limiter for credential endpoints (05-security.md §3).
 * In-memory per process — adequate for a single API instance; swaps to a
 * Redis window when the API scales horizontally. Keyed by IP + email so an
 * attacker can't brute one account across IPs cheaply nor lock others out.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const buckets = new Map<string, number[]>();

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const email =
      typeof (req.body as { email?: unknown })?.email === "string"
        ? (req.body as { email: string }).email.toLowerCase()
        : "";
    const key = `${req.ip ?? "unknown"}:${email}`;
    const now = Date.now();
    const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (hits.length >= MAX_ATTEMPTS) {
      throw new HttpException(
        "Too many attempts; try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    hits.push(now);
    buckets.set(key, hits);
    // Opportunistic cleanup so the map cannot grow unboundedly.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (v.every((t) => now - t >= WINDOW_MS)) buckets.delete(k);
      }
    }
    return true;
  }
}
