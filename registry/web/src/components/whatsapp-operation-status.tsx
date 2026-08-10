import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApplicationMessage, WhatsAppBrowser } from "@/lib/whatsappd/web-contract";

export function WhatsAppOperationStatus({
  message,
  browser,
}: {
  readonly message: ApplicationMessage;
  readonly browser: WhatsAppBrowser;
}) {
  const operation = message.operation;
  if (!operation) return null;
  if (operation.status === "failed")
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Could not send</AlertTitle>
        <AlertDescription>
          {operation.detail ?? "The send failed before WhatsApp accepted it."}
        </AlertDescription>
      </Alert>
    );
  if (operation.status === "outcome_unknown")
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Delivery could not be confirmed</AlertTitle>
        <AlertDescription>
          It may have sent. Check WhatsApp before trying again.
          <Button
            variant="link"
            size="sm"
            onClick={() => void browser.command({ type: "acknowledge", operation: operation.key })}
          >
            Dismiss
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <span className="inline-flex items-center gap-1">
      {operation.status === "succeeded" ? (
        <CheckIcon />
      ) : (
        <LoaderCircleIcon className="animate-spin" />
      )}
      {operation.status === "queued"
        ? "Queued"
        : operation.status === "claimed"
          ? "Preparing"
          : operation.status === "executing"
            ? "Sending"
            : "Sent, syncing"}
    </span>
  );
}
