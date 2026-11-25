export interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
  language: string;
  theme: string;
  avatar: string | null;
  default_model: string | null;
  totp_enabled: boolean;
  theme_mode: 'light' | 'dark' | 'system';
  accent_color: string;
  /** spelling check in the composer (default on), its language, and the moving background (default on) */
  preferences?: { spellcheck?: boolean; spell_lang?: 'nl' | 'en' | 'auto'; bg_motion?: boolean; remote_notice?: boolean } | null;
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  category: 'alias' | 'full';
}

export interface ProjectMember { id: string; name: string; avatar: string | null; is_owner: boolean; color?: string | null }

export interface ProjectAgent {
  id: string; name: string; avatar: string | null; color: string | null; description?: string; owner_id: string; owner_name: string;
  in_project: boolean; account_mode: 'user' | 'owner'; fallback: boolean; user_ids: string[];
}
export interface ProjectEvent {
  id: string; user_id: string | null; user_name: string | null; user_avatar: string | null; action: string; target: string | null;
  details: Record<string, unknown>; created_at: string;
}
export interface ProjectMemoryItem {
  id: string; content: string; topic: string; pinned: boolean; added_by: string | null; added_by_name: string | null;
  added_via: string; source_conversation_id: string | null; updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  icon: string;
  instructions: string;
  chat_count: number;
  last_activity: string | null;
  /** shared projects: all members (owner first); a project with more than one member is shared */
  members?: ProjectMember[];
  is_owner?: boolean;
  shared?: boolean;
  owner_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  /** project this chat belongs to (shared working dir and instructions), null for a loose chat */
  project_id?: string | null;
  /** maker of the chat (differs from the viewer in a shared project) */
  user_id?: string;
  /** unread messages from other members (shared projects) */
  unread?: number;
  title: string;
  model: string;
  status: 'active' | 'archived' | 'deleted';
  token_count: number;
  updated_at: string;
  created_at: string;
  /** Last user/assistant message as a one-line preview (list endpoint only) */
  last_message?: { role: 'user' | 'assistant'; preview: string } | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  token_count: number;
  created_at: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  /** who sent this question (shared projects) */
  user_id?: string | null;
  user_name?: string | null;
  user_avatar?: string | null;
  /** client only: React key that survives the swap of a sent (temp) message for the saved one */
  clientKey?: string;
}

export interface Connector {
  id: string;
  name: string;
  type: 'git' | 'ssh' | 'sftp' | 'ftp' | 'smb' | 'python' | 'sudo' | 'github' | 'focustrack' | 'google-search-console' | 'ninjaone';
  config: Record<string, unknown>;
  is_active: boolean;
  test_status: 'ok' | 'error' | null;
  test_message: string | null;
  last_tested_at: string | null;
  created_at: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  connectors: Pick<Connector, 'id' | 'name' | 'type'>[];
}

export interface Attachment {
  id: string;
  conversation_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  email?: string | null;
}

export interface AdminSession {
  id: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
}
