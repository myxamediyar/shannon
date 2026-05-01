/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — `next build` produces `out/`. The npm CLI shell
  // (bin/shannon.js) serves this directly; the Tauri shell bundles it as
  // frontend resources.
  output: "export",
};

module.exports = nextConfig;
