"use client";

import { ControlRoom } from "@/components/prototype/control-room";
import { DenseInbox } from "@/components/prototype/dense-inbox";
import { PocketInbox } from "@/components/prototype/pocket-inbox";
import { PairingCard } from "@/components/prototype/shared";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, QrCodeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const variants = ["dense", "control", "pocket"] as const;
export type PrototypeVariant = (typeof variants)[number];

const names: Record<PrototypeVariant, string> = {
  dense: "Dense inbox",
  control: "Control room",
  pocket: "Conversation pocket",
};

export function PrototypeApp({
  variant,
  fixture,
}: {
  variant: PrototypeVariant;
  fixture: "online" | "pairing";
}) {
  const router = useRouter();
  const go = (nextVariant: PrototypeVariant, nextFixture = fixture) => {
    router.replace(`/?variant=${nextVariant}&fixture=${nextFixture}`);
  };
  const cycle = (direction: -1 | 1) => {
    const index = variants.indexOf(variant);
    const next = variants[(index + direction + variants.length) % variants.length];
    if (next) go(next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <>
      {fixture === "pairing" ? (
        <main className="flex min-h-svh items-center bg-muted/40 p-6">
          <PairingCard />
        </main>
      ) : variant === "dense" ? (
        <DenseInbox />
      ) : variant === "control" ? (
        <ControlRoom />
      ) : (
        <PocketInbox />
      )}
      {process.env.NODE_ENV !== "production" && (
        <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border bg-foreground p-1.5 text-background shadow-xl">
          <Button
            aria-label="Previous design"
            onClick={() => cycle(-1)}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
          <span className="min-w-36 px-2 text-center font-medium text-xs">
            {variant.toUpperCase()} — {names[variant]}
          </span>
          <Button aria-label="Next design" onClick={() => cycle(1)} size="icon-sm" variant="ghost">
            <ChevronRightIcon />
          </Button>
          <span className="mx-1 h-5 w-px bg-background/25" />
          <Button
            aria-label={fixture === "pairing" ? "Show online fixture" : "Show pairing fixture"}
            onClick={() => go(variant, fixture === "pairing" ? "online" : "pairing")}
            size="icon-sm"
            variant="ghost"
          >
            <QrCodeIcon />
          </Button>
        </div>
      )}
    </>
  );
}
