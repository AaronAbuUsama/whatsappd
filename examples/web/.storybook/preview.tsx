import type { Preview } from "@storybook/nextjs-vite";
import { Toaster } from "../src/components/ui/sonner";
import { TooltipProvider } from "../src/components/ui/tooltip";

const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="dark min-h-svh bg-background text-foreground">
        <TooltipProvider>
          <Story />
        </TooltipProvider>
        <Toaster />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
  },
};

export default preview;
