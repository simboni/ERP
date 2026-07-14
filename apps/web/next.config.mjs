/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone server bundle for the Docker image.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  env: {
    // Explicit URL wins; else the platform-injected API hostname
    // (Render fromService) becomes https://<host>.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ??
      (process.env.API_HOST ? `https://${process.env.API_HOST}` : undefined),
  },
};

export default nextConfig;
