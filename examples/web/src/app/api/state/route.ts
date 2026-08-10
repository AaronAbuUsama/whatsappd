import { applicationState } from "@/lib/whatsapp.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const chat = new URL(request.url).searchParams.get("chat") || undefined;
  try {
    return Response.json(await applicationState(chat), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to read WhatsApp state" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
