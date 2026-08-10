"use client";

import { useRef, useState } from "react";
import {
  CopyIcon,
  ImageIcon,
  LinkIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { WhatsAppApplicationView, WhatsAppBrowser } from "@/lib/whatsappd/web-contract";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Group action failed";

export function WhatsAppGroupCreate({
  browser,
  view,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
}) {
  const eligible = view.contacts.filter((contact) => contact.canCreateGroup);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const create = async (): Promise<void> => {
    try {
      const result = await browser.command({
        type: "group_create",
        subject,
        participants: eligible.map((contact) => contact.groupKey ?? contact.key),
      });
      if (result.type !== "group") throw new Error("Group creation returned no group");
      setOpen(false);
      setSubject("");
      await browser.select(result.key);
      toast.success("Group created");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Create group">
          <PlusIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New proof group</DialogTitle>
          <DialogDescription>
            This local example only permits the configured Android proof account as the other
            member.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="group-subject">Group subject</FieldLabel>
          <Input
            id="group-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={100}
          />
          <FieldDescription>
            {eligible.length
              ? eligible.map((contact) => contact.name).join(", ")
              : "No proof peer is configured."}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button disabled={!subject.trim() || eligible.length !== 1} onClick={() => void create()}>
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WhatsAppGroupDetails({
  browser,
  view,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
}) {
  const conversation = view.conversation!;
  const group = conversation.group;
  const eligible = view.contacts.filter((contact) => contact.canCreateGroup);
  const [subject, setSubject] = useState(conversation.chat.name);
  const [description, setDescription] = useState(group?.description ?? "");
  const picture = useRef<HTMLInputElement>(null);
  const run = async (command: Parameters<WhatsAppBrowser["command"]>[0]): Promise<void> => {
    try {
      await browser.command(command);
      toast.success("Group updated");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const invite = async (revoke = false): Promise<void> => {
    try {
      const result = await browser.command({
        type: revoke ? "group_revoke_invite" : "group_invite",
        chat: conversation.chat.key,
      });
      if (result.type !== "invite" || !result.code) throw new Error("No invite code returned");
      await navigator.clipboard.writeText(`https://chat.whatsapp.com/${result.code}`);
      toast.success(revoke ? "New invite link copied" : "Invite link copied");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <div>
      <Field>
        <FieldLabel htmlFor="group-name">Subject</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="group-name"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={!subject.trim() || subject === conversation.chat.name}
            onClick={() =>
              void run({ type: "group_subject", chat: conversation.chat.key, subject })
            }
          >
            Save
          </Button>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="group-description">Description</FieldLabel>
        <Textarea
          id="group-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button
          variant="outline"
          onClick={() =>
            void run({ type: "group_description", chat: conversation.chat.key, description })
          }
        >
          Save description
        </Button>
      </Field>
      <Separator />
      <Item>
        <ItemContent>
          <ItemTitle>Only admins can send</ItemTitle>
          <ItemDescription>Announcement mode</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            checked={group?.announcement ?? false}
            onCheckedChange={(checked) =>
              void run({
                type: "group_setting",
                chat: conversation.chat.key,
                setting: checked ? "announcement" : "not_announcement",
              })
            }
          />
        </ItemActions>
      </Item>
      <Item>
        <ItemContent>
          <ItemTitle>Only admins can edit group info</ItemTitle>
          <ItemDescription>Lock group settings</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            checked={group?.locked ?? false}
            onCheckedChange={(checked) =>
              void run({
                type: "group_setting",
                chat: conversation.chat.key,
                setting: checked ? "locked" : "unlocked",
              })
            }
          />
        </ItemActions>
      </Item>
      <Separator />
      {eligible.map((contact) => (
        <Button
          key={contact.key}
          variant="outline"
          onClick={() =>
            void run({
              type: "group_participants",
              chat: conversation.chat.key,
              participants: [contact.key],
              action: "add",
            })
          }
        >
          <UserPlusIcon />
          Add {contact.name}
        </Button>
      ))}
      {conversation.participants === undefined && (
        <Item>
          <ItemContent>
            <ItemDescription>Participant list unavailable.</ItemDescription>
          </ItemContent>
        </Item>
      )}
      {conversation.participants?.map((participant) => (
        <Item key={participant.key}>
          <ItemContent>
            <ItemTitle>{participant.name}</ItemTitle>
            <ItemDescription>{participant.role ?? "Participant"}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Manage ${participant.name}`}>
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    void run({
                      type: "group_participants",
                      chat: conversation.chat.key,
                      participants: [participant.key],
                      action: participant.role ? "demote" : "promote",
                    })
                  }
                >
                  {participant.role ? "Remove admin" : "Make admin"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    void run({
                      type: "group_participants",
                      chat: conversation.chat.key,
                      participants: [participant.key],
                      action: "remove",
                    })
                  }
                >
                  <UserMinusIcon />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ItemActions>
        </Item>
      ))}
      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void invite()}>
          <LinkIcon />
          Copy invite link
        </Button>
        <Button variant="outline" onClick={() => void invite(true)}>
          <CopyIcon />
          Reset invite link
        </Button>
        <Button variant="outline" onClick={() => picture.current?.click()}>
          <ImageIcon />
          Change picture
        </Button>
        <input
          ref={picture}
          type="file"
          accept="image/jpeg,image/png"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void browser
                .sendMedia({ type: "group_picture", chat: conversation.chat.key }, file)
                .then(() => toast.success("Group picture updated"))
                .catch((error) => toast.error(errorMessage(error)));
            event.target.value = "";
          }}
        />
        <Button
          variant="outline"
          onClick={() => void run({ type: "group_remove_picture", chat: conversation.chat.key })}
        >
          <Trash2Icon />
          Remove picture
        </Button>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">
            <LogOutIcon />
            Leave group
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this group?</AlertDialogTitle>
            <AlertDialogDescription>
              This action is sent immediately and is not retried.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void run({ type: "group_leave", chat: conversation.chat.key })}
            >
              Leave group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
