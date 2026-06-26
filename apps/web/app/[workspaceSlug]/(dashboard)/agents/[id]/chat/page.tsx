"use client";

import { use } from "react";
import { AgentChatPage } from "@multica/views/chat";

export default function AgentChatRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AgentChatPage agentId={id} />;
}
