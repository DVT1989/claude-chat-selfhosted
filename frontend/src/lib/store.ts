import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Conversation, Message, Project } from '@/types';

interface AuthStore {
  user: User | null;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
    }),
    { name: 'auth-store', partialize: (s) => ({ user: s.user }) },
  ),
);

interface ChatStore {
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  /** which tab and which project the list shows (survives leaving the list on phones) */
  listTab: 'chats' | 'projects';
  openProjectId: string | null;
  setListView: (tab: 'chats' | 'projects', projectId?: string | null) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  streamingMessage: string;
  isStreaming: boolean;
  /** Live answer per conversation: a run in one chat (e.g. the admin chat) never shows in another */
  streams: Record<string, { on: boolean; text: string }>;
  setStream: (conversationId: string, patch: Partial<{ on: boolean; text: string }>) => void;
  sidebarOpen: boolean;
  sessionCost: number;
  sessionTokens: number;
  sessionMessages: number;
  /** Set to a conversationId when a background resume completes — ChatWindow reloads messages */
  refreshConversationId: string | null;

  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (conversationId: string, messages: Message[]) => void;
  addMessage: (conversationId: string, message: Message) => void;
  appendStreamChunk: (text: string) => void;
  setStreaming: (streaming: boolean) => void;
  clearStreamingMessage: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  addSessionCost: (cost: number) => void;
  addSessionTokens: (input: number, output: number) => void;
  setRefreshConversationId: (id: string | null) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  projects: [],
  setProjects: (projects) => set({ projects }),
  listTab: 'chats',
  openProjectId: null,
  setListView: (listTab, openProjectId = null) => set({ listTab, openProjectId }),
  conversations: [],
  activeConversationId: null,
  messages: {},
  streamingMessage: '',
  isStreaming: false,
  streams: {},
  setStream: (id, patch) => set((state) => {
    const cur = state.streams[id] ?? { on: false, text: '' };
    const next = { ...cur, ...patch };
    if (next.on === cur.on && next.text === cur.text) return {};
    return { streams: { ...state.streams, [id]: next } };
  }),
  sidebarOpen: false,
  sessionCost: 0,
  sessionTokens: 0,
  sessionMessages: 0,
  refreshConversationId: null,

  setConversations: (conversations) => set({ conversations }),

  addConversation: (conversation) =>
    set((state) => ({ conversations: [conversation, ...state.conversations] })),

  updateConversation: (id, updates) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, ...updates } : c,
      ),
    })),

  removeConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
    })),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  // A refresh that brings nothing new keeps the same array: no re-render, no scroll, no flicker
  setMessages: (conversationId, messages) =>
    set((state) => {
      const cur = state.messages[conversationId];
      const same = cur && cur.length === messages.length && cur.every((m, i) => {
        const n = messages[i];
        return m.id === n.id && m.content === n.content && m.role === n.role
          && (m.metadata as { streaming?: unknown } | undefined)?.streaming === (n.metadata as { streaming?: unknown } | undefined)?.streaming;
      });
      if (same) return {};
      // A saved message that replaces the one shown while sending keeps its key: no remount, no flicker
      if (cur?.length) {
        const keyOf = new Map(cur.filter((m) => m.clientKey).map((m) => [m.id, m.clientKey!]));
        const temps = cur.filter((m) => m.id.startsWith('temp-'));
        const known = new Set(cur.map((m) => m.id));
        messages = messages.map((m) => {
          if (keyOf.has(m.id)) return { ...m, clientKey: keyOf.get(m.id) };
          if (known.has(m.id)) return m;
          const i = temps.findIndex((t) => t.role === m.role && t.content === m.content);
          if (i < 0) return m;
          const [t] = temps.splice(i, 1);
          return { ...m, clientKey: t.clientKey ?? t.id, attachments: m.attachments ?? t.attachments };
        });
      }
      return { messages: { ...state.messages, [conversationId]: messages } };
    }),

  addMessage: (conversationId, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: [...(state.messages[conversationId] ?? []), message],
      },
    })),

  appendStreamChunk: (text) =>
    set((state) => ({ streamingMessage: state.streamingMessage ? state.streamingMessage + '\n\n' + text : text })),

  setStreaming: (isStreaming) => set({ isStreaming }),

  clearStreamingMessage: () => set({ streamingMessage: '' }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  addSessionCost: (cost) => set((state) => ({ sessionCost: state.sessionCost + cost })),
  addSessionTokens: (input, output) => set((state) => ({
    sessionTokens: state.sessionTokens + input + output,
    sessionMessages: state.sessionMessages + 1,
  })),

  setRefreshConversationId: (id) => set({ refreshConversationId: id }),
}));
