import type { ReactNode } from "react";
import { CircleDashedIcon } from "lucide-react";
import { WhatsAppMessageContent } from "@/components/whatsapp-message";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { WhatsAppApplicationView } from "@/lib/whatsapp-application";

const time = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
const date = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);

export function WhatsAppUpdates({
  view,
  navigation,
}: {
  readonly view: WhatsAppApplicationView;
  readonly navigation: ReactNode;
}) {
  return (
    <section className="flex h-svh min-w-0 flex-col">
      {navigation}
      <header className="border-b px-4 py-3">
        <h1 className="text-2xl font-semibold lg:text-lg">Updates</h1>
        <p className="text-sm text-muted-foreground">Saved WhatsApp status posts</p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {view.updates.length ? (
          <div className="mx-auto grid max-w-2xl gap-4 p-4">
            {view.updates.map((update) => (
              <Card key={update.key} size="sm">
                <CardHeader>
                  <Item size="xs" className="border-0 p-0">
                    <ItemMedia>
                      <Avatar size="lg">
                        {update.avatar && (
                          <AvatarImage
                            src={`/api/avatar/${update.avatar}`}
                            alt={update.sender}
                            loading="lazy"
                          />
                        )}
                        <AvatarFallback>{update.initials}</AvatarFallback>
                      </Avatar>
                    </ItemMedia>
                    <ItemContent className="min-w-0 gap-0">
                      <ItemTitle className="w-full truncate">{update.sender}</ItemTitle>
                      <ItemDescription>{date(update.timestamp)}</ItemDescription>
                    </ItemContent>
                    <ItemActions className="text-xs text-muted-foreground">
                      {time(update.timestamp)}
                    </ItemActions>
                  </Item>
                </CardHeader>
                <CardContent>
                  <WhatsAppMessageContent content={update.content} />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className="h-full rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleDashedIcon />
              </EmptyMedia>
              <EmptyTitle>No saved updates</EmptyTitle>
              <EmptyDescription>New status posts will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </section>
  );
}
