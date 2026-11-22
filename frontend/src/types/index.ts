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

export interface Conversation {
  id: string;
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
  /** client only: React key that survives the swap of a sent (temp) message for the saved one */
  clientKey?: string;
}

export interface Connector {
  id: string;
  name: string;
  type: 'git' | 'ssh' | 'sftp' | 'ftp' | 'smb' | 'python' | 'sudo' | 'github' | 'focustrack';
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
