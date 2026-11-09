import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    // The browser talks to the API on its own origin by default, which keeps the session cookie
    // first-party and avoids CORS entirely. Behind nginx that is already true — nginx serves
    // `/api/` — so these rewrites only matter for `next dev` / `next start` and for the plain
    // docker compose stack, where nothing else would answer on `/api/v1` at all.
    //
    // `NEXT_PUBLIC_API_BASE_URL` still overrides this when a deployment wants the browser to call
    // the API host directly.
    const api = process.env.API_BASE_URL_INTERNAL ?? 'http://localhost:3001/api/v1';
    return [
      { source: '/api/v1/:path*', destination: `${api}/:path*` },
      { source: '/api/proxy/:path*', destination: `${api}/:path*` },
    ];
  },
};

export default nextConfig;
