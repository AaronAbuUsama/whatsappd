import { mediaTarget } from "@/lib/whatsapp.server";
import { mediaResponse } from "@/lib/media-response";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (process.env.NODE_ENV === "development" && token === "prototype-attachment.svg")
    return Response.redirect(new URL("/prototype-attachment.svg", request.url));
  const target = await mediaTarget(token);
  if (!target) return new Response("Not found", { status: 404 });

  return mediaResponse(request, target);
}
