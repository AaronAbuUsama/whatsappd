import { PrototypeApp } from "@/components/prototype/prototype-app";

const prototypeVariants = ["dense", "control", "pocket"] as const;
type PrototypeVariant = (typeof prototypeVariants)[number];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string; fixture?: string }>;
}) {
  const params = await searchParams;
  const variant = prototypeVariants.includes(params.variant as PrototypeVariant)
    ? (params.variant as PrototypeVariant)
    : "dense";
  const fixture = params.fixture === "pairing" ? "pairing" : "online";
  return <PrototypeApp fixture={fixture} variant={variant} />;
}
