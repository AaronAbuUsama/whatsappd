"use client";

import { ChatList, ConnectionBadge, ConversationPanel } from "@/components/prototype/shared";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ContactRoundIcon,
  EllipsisVerticalIcon,
  MessageSquareIcon,
  Settings2Icon,
} from "lucide-react";

export function DenseInbox() {
  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden" defaultOpen={false}>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader>
          <div className="flex h-10 items-center gap-2 px-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 font-bold text-white">
              W
            </div>
            <span className="font-semibold group-data-[collapsible=icon]:hidden">whatsappd</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive tooltip="Conversations">
                    <MessageSquareIcon />
                    <span>Conversations</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Contacts">
                    <ContactRoundIcon />
                    <span>Contacts</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Settings">
                    <Settings2Icon />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 p-1">
            <Avatar className="size-8">
              <AvatarFallback>AU</AvatarFallback>
            </Avatar>
            <ConnectionBadge compact />
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 overflow-hidden">
        <ResizablePanelGroup className="min-h-0" orientation="horizontal">
          <ResizablePanel defaultSize="30%" minSize="22%">
            <ChatList dense />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="70%" minSize="45%">
            <div className="relative h-full">
              <ConversationPanel />
              <Sheet>
                <SheetTrigger asChild>
                  <Button className="absolute top-4 right-4" size="icon-sm" variant="ghost">
                    <EllipsisVerticalIcon />
                    <span className="sr-only">Conversation details</span>
                  </Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Product studio</SheetTitle>
                    <SheetDescription>Group details stay renderer-owned.</SheetDescription>
                  </SheetHeader>
                  <div className="space-y-4 px-4 text-sm">
                    <div>
                      <p className="font-medium">Participants</p>
                      <p className="text-muted-foreground">Maya, Dara, Sam and you</p>
                    </div>
                    <div>
                      <p className="font-medium">Media</p>
                      <p className="text-muted-foreground">
                        12 images · 3 documents · 1 voice note
                      </p>
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  );
}
