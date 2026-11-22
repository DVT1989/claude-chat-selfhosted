import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import ChatWindow from '@/components/chat/ChatWindow';
import type { ConversationDetail, Message } from '@/types';

async function getConversation(id: string, cookieHeader: string): Promise<ConversationDetail | null> {
  try {
    // Server-side fetch directly to backend (internal Docker network)
    const res = await fetch(`http://backend:4000/conversations/${id}`, {
      headers: { Cookie: cookieHeader },
      cache: 'no-store',
    });
    if (res.status === 401) redirect('/login');
    if (!res.ok) return null;
    const data = await res.json() as {
      conversation: ConversationDetail;
      messages: Message[];
      connectors: ConversationDetail['connectors'];
    };
    return {
      ...data.conversation,
      messages: data.messages,
      connectors: data.connectors,
    };
  } catch {
    return null;
  }
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const conversation = await getConversation(id, cookieHeader);
  if (!conversation) notFound();

  // an agent's workplace is watched in its card, not opened as a conversation: go to the parent with the card open
  const metaOf = (c: ConversationDetail) => ((c as { metadata?: Record<string, unknown> | null }).metadata ?? {});
  const meta = metaOf(conversation);
  if (typeof meta.delegation_id === 'string' && typeof meta.parent_conversation_id === 'string') {
    const parent = await getConversation(meta.parent_conversation_id, cookieHeader);
    if (parent) {
      const q = `?delegation=${encodeURIComponent(meta.delegation_id)}`;
      redirect(metaOf(parent).isSystem === true ? `/settings/adminprompt${q}` : `/chat/${parent.id}${q}`);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* keyed: every conversation gets its own window, nothing of a previous chat's run carries over */}
      <ChatWindow
        key={conversation.id}
        conversationId={conversation.id}
        initialMessages={conversation.messages}
      />
    </div>
  );
}
