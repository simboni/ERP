import type { NextFunction, Request, Response } from "express";

/**
 * Structured request logging (05-security.md §4): one JSON line per
 * request with method, path, status, duration and the tenant id from the
 * verified token (never bodies, never tokens, never PII). Feeds any log
 * aggregator; OpenTelemetry traces layer on top post go-live.
 */
export function requestLogger(
  req: Request & { claims?: { tid?: string; sub?: string } },
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      t: new Date().toISOString(),
      m: req.method,
      p: req.path,
      s: res.statusCode,
      ms: Math.round(durationMs * 10) / 10,
      tid: req.claims?.tid ?? null,
      ip: req.ip,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  });
  next();
}
