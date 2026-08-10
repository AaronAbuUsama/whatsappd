import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { WhatsAppApplicationView } from "@/lib/whatsappd/web-contract";

export function WhatsAppAccountState({ view }: { readonly view: WhatsAppApplicationView }) {
  const connection = view.account.connection;
  if (!connection || connection.phase === "online") return null;
  if (connection.phase === "stale")
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <CircleAlertIcon />
        <AlertTitle>Connection status is stale</AlertTitle>
        <AlertDescription>
          No recent live status was observed. Durable sends remain available.
        </AlertDescription>
      </Alert>
    );
  const terminal =
    connection.phase === "closed" ||
    connection.phase === "logged_out" ||
    connection.phase === "suspended";
  return (
    <Alert
      variant={terminal ? "destructive" : "default"}
      className="rounded-none border-x-0 border-t-0"
    >
      {terminal ? <CircleAlertIcon /> : <LoaderCircleIcon className="animate-spin" />}
      <AlertTitle>{connection.phase.replaceAll("_", " ")}</AlertTitle>
      <AlertDescription>{connection.detail ?? "WhatsApp is not ready yet."}</AlertDescription>
    </Alert>
  );
}
