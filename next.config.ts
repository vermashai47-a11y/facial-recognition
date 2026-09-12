import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Next 16 builds with Turbopack by default and errors out if a `webpack` key
  // is present without this. An empty object is all we need: every module that
  // touches onnxruntime-web is 'use client', so its Node-only bindings are never
  // pulled into a server bundle and no resolve fallbacks are required.
  turbopack: {},

  async headers() {
    return [
      {
        // SharedArrayBuffer is what lets onnxruntime-web use multi-threaded WASM.
        // Without these two headers the runtime silently falls back to a single
        // thread, which roughly triples embedding latency on mid-range phones.
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), geolocation=(self), microphone=()',
          },
        ],
      },
      {
        source: '/models/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
