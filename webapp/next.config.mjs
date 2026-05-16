/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "32mb" },
  },
  serverExternalPackages: ["bcryptjs"],
};

export default nextConfig;
