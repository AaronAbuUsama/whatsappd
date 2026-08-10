import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions = (): BaseLayoutProps => ({
  nav: { title: "whatsappd" },
  links: [
    { text: "Documentation", url: "/docs" },
    { text: "GitHub", url: "https://github.com/AaronAbuUsama/whatsappd", external: true },
  ],
});
