"use client";

import type { ReactNode } from "react";
import { ArchiveIcon, CircleAlertIcon, CircleDashedIcon, PhoneIcon, RadioIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WhatsAppApplicationView } from "@/lib/whatsappd/web-contract";

export function WhatsAppSettings({
  view,
  navigation,
}: {
  readonly view: WhatsAppApplicationView;
  readonly navigation: ReactNode;
}) {
  const { theme = "system", setTheme } = useTheme();
  const connection = view.account.connection;
  return (
    <section className="flex h-svh min-w-0 flex-col">
      {navigation}
      <header className="border-b px-4 py-4">
        <h1 className="text-2xl font-semibold md:text-lg">Settings</h1>
      </header>
      <div className="mx-auto grid w-full max-w-3xl gap-4 overflow-y-auto p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle>{view.account.name}</CardTitle>
            <CardDescription>WhatsApp account</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-2 text-sm">
            <RadioIcon className="size-4" />
            {connection?.phase.replaceAll("_", " ") ?? "No live connection observed"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Stored locally; no account content is persisted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger aria-label="Theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Deferred capabilities</AlertTitle>
          <AlertDescription>
            Calls, archives, and publishing Updates are not exposed by the current SDK.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button disabled variant="outline">
            <PhoneIcon />
            Calls unavailable
          </Button>
          <Button disabled variant="outline">
            <ArchiveIcon />
            Archive unavailable
          </Button>
          <Button disabled variant="outline">
            <CircleDashedIcon />
            Publish Update unavailable
          </Button>
        </div>
      </div>
    </section>
  );
}
