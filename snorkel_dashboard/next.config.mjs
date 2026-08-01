/*
 * In production this builds to a folder of static files that the node server
 * hosts itself (output: 'export'). That means the dashboard is served from the
 * same origin as the API, so there is no CORS to configure and no second
 * process to keep running.
 *
 * In dev, `next dev` runs on :3000 while the API is on :8787, so rewrites proxy
 * the API calls across. Rewrites are a dev-server feature and cannot be part of
 * a static export, which is why they are only declared for development.
 */

const isDev = process.env.NODE_ENV === 'development';
const apiTarget = process.env.SERVER_URL || 'http://localhost:8787';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  ...(isDev
    ? {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${apiTarget}/api/:path*` },
            { source: '/start_new_task', destination: `${apiTarget}/start_new_task` },
          ];
        },
      }
    : {
        output: 'export',
        // Static hosts serve /path/ as /path/index.html.
        trailingSlash: true,
        images: { unoptimized: true },
      }),
};

export default config;
