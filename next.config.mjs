/** @type {import('next').NextConfig} */
const nextConfig = {
  // Production builds go to a SEPARATE directory so `npm run build` no longer
  // wipes the running dev server's .next/ chunks (that was the recurring
  // "white page, no CSS" — dev HTML referenced files the build had deleted).
  // Override with DIST_DIR env if ever needed.
  distDir: process.env.DIST_DIR || ".next",
};

export default nextConfig;
