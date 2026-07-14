/**
 * Runtime config for the browser. The API address is read from the
 * server's RUNTIME environment (Render injects API_HOST via the service
 * link), so the web app finds its API even when the Docker image was
 * built before the API's hostname existed — no rebuild needed.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ??
    (process.env.API_HOST ? `https://${process.env.API_HOST}` : null);
  return Response.json({ apiUrl });
}
