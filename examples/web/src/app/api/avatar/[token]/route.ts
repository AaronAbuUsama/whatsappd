import { avatarTarget } from "@/lib/whatsapp.server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (process.env.NODE_ENV === "development" && token === "state-lab-shared")
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#0f766e"/><circle cx="32" cy="24" r="12" fill="#ccfbf1"/><path d="M12 58c2-14 10-21 20-21s18 7 20 21" fill="#ccfbf1"/></svg>',
      { headers: { "Cache-Control": "private, no-store", "Content-Type": "image/svg+xml" } },
    );
  if (process.env.NODE_ENV === "development" && token === "state-lab-broken")
    return new Response("not an image", {
      headers: { "Cache-Control": "private, no-store", "Content-Type": "image/png" },
    });
  const target = await avatarTarget(token);
  if (!target) return new Response("Not found", { status: 404 });
  let response: Response;
  try {
    response = await fetch(target, { cache: "no-store" });
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!response.ok || !response.body) return new Response("Not found", { status: 404 });
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 10 * 1024 * 1024)
    return new Response("Avatar is too large", { status: 413 });
  return new Response(response.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
    },
  });
}
