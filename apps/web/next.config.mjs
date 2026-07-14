/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // "export" = static bundle served by the API (single-origin deploy);
  // "standalone" = self-hosting Next server (legacy two-service deploy).
  ...(process.env.NEXT_OUTPUT === "export"
    ? { output: "export" }
    : process.env.NEXT_OUTPUT === "standalone"
      ? { output: "standalone" }
      : {}),
  env: {
    // Explicit URL wins; else the platform-injected API hostname
    // (Render fromService) becomes https://<host>.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ??
      (process.env.API_HOST ? `https://${process.env.API_HOST}` : undefined),
  },
};

export default nextConfig;
