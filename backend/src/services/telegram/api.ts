/** Minimal Telegram Bot API client (long polling, plain-text messages). */
import type { TgUpdate } from './bot';

export class TelegramError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function base(): string {
  return process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
}

async function call<T>(token: string, method: string, body: object, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${base()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!res.ok || !data.ok) throw new TelegramError(data.error_code ?? res.status, data.description ?? `HTTP ${res.status}`);
  return data.result as T;
}

export function getMe(token: string): Promise<{ id: number; username: string; first_name?: string }> {
  return call(token, 'getMe', {});
}

export function getUpdates(token: string, offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
  return call(token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 15) * 1000, signal);
}

export async function sendMessage(token: string, chatId: number, text: string, html = false): Promise<void> {
  await call(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) });
}

export async function sendTyping(token: string, chatId: number): Promise<void> {
  await call(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
}

export async function setProfile(token: string, name: string, description: string, shortDescription: string): Promise<void> {
  await call(token, 'setMyName', { name });
  await call(token, 'setMyDescription', { description });
  await call(token, 'setMyShortDescription', { short_description: shortDescription });
}

export async function setCommands(token: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  await call(token, 'setMyCommands', { commands });
}
