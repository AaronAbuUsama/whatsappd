import { createMDX } from "fumadocs-mdx/next";

const onPages = process.env.GITHUB_ACTIONS === "true";

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  trailingSlash: true,
  basePath: onPages ? "/whatsappd" : "",
  images: { unoptimized: true },
};

export default createMDX()(config);
