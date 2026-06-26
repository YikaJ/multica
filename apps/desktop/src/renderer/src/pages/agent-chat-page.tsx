import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AgentChatPage as SharedAgentChatPage } from "@multica/views/chat";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function AgentChatPage() {
  const { id } = useParams<{ id: string }>();
  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const agent = agents.find((a) => a.id === id) ?? null;

  useDocumentTitle(agent ? `${agent.name} Chat` : "Agent Chat");

  if (!id) return null;
  return <SharedAgentChatPage agentId={id} />;
}
