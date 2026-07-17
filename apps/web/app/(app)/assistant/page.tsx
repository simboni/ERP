"use client";

import { useEffect } from "react";
import AssistantChat from "@/components/AssistantChat";

export default function AssistantPage() {
  // Full-bleed: the dedicated route owns the whole area below the top bar,
  // same as Chat, instead of sitting inside the padded page frame.
  useEffect(() => {
    document.body.classList.add("chat-fullbleed");
    return () => document.body.classList.remove("chat-fullbleed");
  }, []);

  return <AssistantChat variant="page" />;
}
