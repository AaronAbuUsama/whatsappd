"use client";

import {
  ChatList,
  ConnectionBadge,
  ConversationPanel,
  UnknownOutcomeAlert,
} from "@/components/prototype/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { prototypeOperations } from "@/lib/prototype-data";
import { ActivityIcon, MessagesSquareIcon, RadioTowerIcon } from "lucide-react";

export function ControlRoom() {
  return (
    <main className="min-h-svh bg-muted/35 p-3 sm:p-6">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-sm">Account workspace</p>
            <h1 className="font-semibold text-2xl tracking-tight">WhatsApp control room</h1>
          </div>
          <ConnectionBadge />
        </header>
        <section className="grid gap-4 md:grid-cols-3">
          <StatusCard
            description="Lease held · last sync 8s ago"
            icon={<RadioTowerIcon />}
            title="Account health"
            value="Online"
          />
          <StatusCard
            description="4 retained · 2 groups"
            icon={<MessagesSquareIcon />}
            title="Conversations"
            value="4"
          />
          <StatusCard
            description="One outcome requires review"
            icon={<ActivityIcon />}
            title="Durable operations"
            value="4"
          />
        </section>
        <UnknownOutcomeAlert />
        <Tabs defaultValue="workspace">
          <TabsList>
            <TabsTrigger value="workspace">Conversation workspace</TabsTrigger>
            <TabsTrigger value="operations">Operations</TabsTrigger>
          </TabsList>
          <TabsContent value="workspace">
            <Card className="h-[min(720px,calc(100svh-18rem))] min-h-[520px] overflow-hidden p-0">
              <div className="grid h-full min-h-0 md:grid-cols-[320px_1fr]">
                <div className="hidden min-h-0 border-r md:block">
                  <ChatList dense />
                </div>
                <ConversationPanel compact />
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="operations">
            <Card>
              <CardHeader>
                <CardTitle>Operation journal</CardTitle>
                <CardDescription>Only operations initiated by this application.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                {prototypeOperations.map((operation) => (
                  <div className="rounded-xl border p-4" key={operation.label}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{operation.label}</span>
                      <Badge variant={operation.tone}>{operation.value}</Badge>
                    </div>
                    <Progress className="mt-4" value={operation.value * 25} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function StatusCard({
  title,
  value,
  description,
  icon,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardDescription>{title}</CardDescription>
          <CardTitle className="mt-1 text-3xl">{value}</CardTitle>
        </div>
        <div className="rounded-lg bg-muted p-2 text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{description}</CardContent>
    </Card>
  );
}
