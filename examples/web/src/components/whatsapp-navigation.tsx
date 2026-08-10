"use client";

import type { LucideIcon } from "lucide-react";
import {
  ArchiveIcon,
  CircleDashedIcon,
  ContactRoundIcon,
  MessageCircleIcon,
  PhoneIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type WhatsAppSection = "chats" | "updates" | "contacts" | "groups" | "settings";

type NavigationProps = {
  readonly section: WhatsAppSection;
  readonly setSection: (section: WhatsAppSection) => void;
};

export function WhatsAppNavigation({ section, setSection }: NavigationProps) {
  const item = (value: WhatsAppSection, label: string, Icon: LucideIcon) => (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={section === value}
        tooltip={label}
        onClick={() => setSection(value)}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          {item("chats", "Chats", MessageCircleIcon)}
          <SidebarMenuItem>
            <SidebarTrigger className="size-8" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {item("contacts", "Contacts", ContactRoundIcon)}
              {item("updates", "Updates", CircleDashedIcon)}
              {item("groups", "Groups", UsersIcon)}
              <SidebarMenuItem>
                <SidebarMenuButton disabled tooltip="Archive is not exposed by the SDK">
                  <ArchiveIcon />
                  <span>Archived</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton disabled tooltip="Calls are not exposed by the SDK">
                  <PhoneIcon />
                  <span>Calls</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>{item("settings", "Settings", SettingsIcon)}</SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function WhatsAppMobileNavigation({ section, setSection }: NavigationProps) {
  const item = (value: WhatsAppSection, label: string, Icon: LucideIcon) => (
    <TabsTrigger value={value} aria-label={label}>
      <Icon />
      <span className="hidden min-[420px]:inline">{label}</span>
    </TabsTrigger>
  );
  return (
    <Tabs
      value={section}
      onValueChange={(value) => setSection(value as WhatsAppSection)}
      className="md:hidden"
    >
      <TabsList variant="line" className="grid h-12 w-full grid-cols-5 border-b px-2">
        {item("chats", "Chats", MessageCircleIcon)}
        {item("updates", "Updates", CircleDashedIcon)}
        {item("contacts", "Contacts", ContactRoundIcon)}
        {item("groups", "Groups", UsersIcon)}
        {item("settings", "Settings", SettingsIcon)}
      </TabsList>
    </Tabs>
  );
}
