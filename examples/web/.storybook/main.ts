import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: "@storybook/nextjs-vite",
  core: { disableTelemetry: true },
  staticDirs: [
    { from: "../public", to: "/" },
    { from: "../public", to: "/api/media" },
  ],
};

export default config;
