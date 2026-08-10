import { mediaTarget } from "@/lib/whatsapp.server";
import { mediaResponse } from "@/lib/media-response";

export const dynamic = "force-dynamic";

const image = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" rx="16" fill="#0f766e"/><circle cx="80" cy="60" r="32" fill="#ccfbf1"/></svg>',
);
const stateLabMedia: Readonly<
  Record<
    string,
    { readonly bytes: Uint8Array; readonly mimetype: string; readonly fileName?: string }
  >
> = {
  "state-lab-image": { bytes: image, mimetype: "image/svg+xml" },
  "state-lab-audio": {
    bytes: Buffer.from(
      "T2dnUwACAAAAAAAAAACYMIvWAAAAAO+WUwwBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAJgwi9YBAAAAwlSSOQE8T3B1c1RhZ3MMAAAATGF2ZjYwLjMuMTAwAQAAABwAAABlbmNvZGVyPUxhdmM2MC4zLjEwMCBsaWJvcHVzT2dnUwAEGDAAAAAAAACYMIvWAgAAAEa+vCYNCAkICAgICAgICAgICEgL5ME27MWASAfJcifhROpQSAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwA==",
      "base64",
    ),
    mimetype: "audio/ogg",
  },
  "state-lab-video": {
    bytes: Buffer.from(
      "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIVEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEcTbuMU6uEHFO7a1OsggH/7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjAuMy4xMDBXQYxMYXZmNjAuMy4xMDBEiYhAeQAAAAAAABZUrmvBrgEAAAAAAAA414EBc8WIgR4e2k8lSU+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4ImwgUC6gUCagQISVMNn+3Nzn2PAgGfImUWjh0VOQ09ERVJEh4xMYXZmNjAuMy4xMDBzc9ZjwItjxYiBHh7aTyVJT2fIoEWjh0VOQ09ERVJEh5NMYXZjNjAuMy4xMDAgbGlidnB4Z8iiRaOIRFVSQVRJT05Eh5QwMDowMDowMC40MDAwMDAwMDAAAB9DtnXe54EAo8GBAACAkAMAnQEqQABAAABHCIWFiIWEiAICAnWqA/gCBuhBXDHSEwBVWAD+/CnR/4hno9TJd/+ia/omv6Jr/6G4AKOWgQDIANEBAAEQEAAYABhYL/QACI6AABxTu2uRu4+zgQC3iveBAfGCAZzwgQM=",
      "base64",
    ),
    mimetype: "video/webm",
  },
  "state-lab-document": {
    bytes: Buffer.from("Invented state-lab document.\n"),
    mimetype: "text/plain",
    fileName: "invented-note.txt",
  },
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const fixture = process.env.NODE_ENV === "development" ? stateLabMedia[token] : undefined;
  if (fixture)
    return mediaResponse(request, {
      source: {
        async *[Symbol.asyncIterator]() {
          yield fixture.bytes;
        },
      },
      byteLength: fixture.bytes.byteLength,
      mimetype: fixture.mimetype,
      ...(fixture.fileName && { fileName: fixture.fileName }),
    });
  const target = await mediaTarget(token);
  if (!target) return new Response("Not found", { status: 404 });

  return mediaResponse(request, target);
}
