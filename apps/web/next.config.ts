import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    // Keep the API origin server-side so the browser never needs the internal hostname.
    return [
      {
        source: '/api/proxy/:path*',
        destination: `${process.env.API_BASE_URL_INTERNAL ?? 'http://localhost:3001/api/v1'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
