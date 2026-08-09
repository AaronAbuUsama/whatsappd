import { avatarTarget } from "@/lib/whatsapp.server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
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
