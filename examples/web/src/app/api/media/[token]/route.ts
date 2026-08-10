import { mediaTarget } from "@/lib/whatsapp.server";
import { mediaResponse } from "@/lib/media-response";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const target = await mediaTarget(token);
  if (!target) return new Response("Not found", { status: 404 });

  return mediaResponse(request, target);
}
