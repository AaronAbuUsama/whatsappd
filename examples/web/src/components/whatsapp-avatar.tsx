"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarSource } from "@/lib/avatar-cache";

export function WhatsAppAvatar({
  name,
  initials,
  token,
  size,
}: {
  readonly name: string;
  readonly initials: string;
  readonly token?: string;
  readonly size?: "sm" | "default" | "lg";
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let current = true;
    setSource(undefined);
    const target = element.current;
    if (!token || !target) return;
    const load = (): void => {
      void avatarSource(token).then((value) => current && setSource(value));
    };
    if (typeof IntersectionObserver === "undefined") load();
    else {
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          load();
        },
        { rootMargin: "200px" },
      );
      observer.observe(target);
      return () => {
        current = false;
        observer.disconnect();
      };
    }
    return () => {
      current = false;
    };
  }, [token]);
  return (
    <Avatar ref={element} size={size}>
      {source && <AvatarImage src={source} alt={name} />}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  );
}
