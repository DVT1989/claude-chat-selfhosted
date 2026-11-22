/**
 * The user's WhatsApp address book, so Claude can find "Jan" instead of needing a number.
 * Filled from the app-state sync (names as saved on the phone) and from push names WhatsApp sends.
 * Only names and numbers; no messages.
 */
import { query } from '../../db';

export interface ContactRow { jid: string; lid: string | null; phone: string | null; name: string | null; notify: string | null }
export interface ContactHit { name: string; phone: string; notify: string | null }

export async function ensureContactsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      jid TEXT NOT NULL,
      lid TEXT,
      phone TEXT,
      name TEXT,
      notify TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, jid)
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_wa_contacts_lid ON whatsapp_contacts(user_id, lid)');
}

/** "31612345678@s.whatsapp.net" / "31612345678:3@s.whatsapp.net" -> "31612345678" */
export function phoneOfJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const d = jid.split('@')[0].split(':')[0];
  return /^\d{6,16}$/.test(d) ? d : null;
}

/** Upsert; an empty field never overwrites a known value. */
export async function saveContacts(userId: string, rows: ContactRow[]): Promise<void> {
  for (const r of rows) {
    if (!r.jid || r.jid.endsWith('@g.us') || r.jid.endsWith('@broadcast') || r.jid.endsWith('@newsletter')) continue;
    await query(
      `INSERT INTO whatsapp_contacts (user_id, jid, lid, phone, name, notify) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, jid) DO UPDATE SET
         lid = COALESCE(EXCLUDED.lid, whatsapp_contacts.lid),
         phone = COALESCE(EXCLUDED.phone, whatsapp_contacts.phone),
         name = COALESCE(EXCLUDED.name, whatsapp_contacts.name),
         notify = COALESCE(EXCLUDED.notify, whatsapp_contacts.notify),
         updated_at = now()`,
      [userId, r.jid, r.lid, r.phone, r.name?.trim() || null, r.notify?.trim() || null]);
  }
}

/** A LID got its phone number: fill it in on the rows that only knew the LID. */
export async function savePhoneForLid(userId: string, lid: string, phone: string): Promise<void> {
  await query('UPDATE whatsapp_contacts SET phone = $3, updated_at = now() WHERE user_id = $1 AND (lid = $2 OR jid = $2) AND phone IS NULL',
    [userId, lid, phone]);
}

export async function contactsWithoutPhone(userId: string): Promise<string[]> {
  const r = await query<{ lid: string }>(
    `SELECT COALESCE(lid, jid) AS lid FROM whatsapp_contacts WHERE user_id = $1 AND phone IS NULL AND COALESCE(lid, jid) LIKE '%@lid'`, [userId]);
  return r.rows.map((x) => x.lid);
}

export async function countContacts(userId: string): Promise<{ total: number; named: number }> {
  const r = await query<{ total: string; named: string }>(
    `SELECT count(*) FILTER (WHERE phone IS NOT NULL) AS total,
            count(*) FILTER (WHERE phone IS NOT NULL AND name IS NOT NULL) AS named
       FROM whatsapp_contacts WHERE user_id = $1`, [userId]);
  return { total: Number(r.rows[0]?.total ?? 0), named: Number(r.rows[0]?.named ?? 0) };
}

/** Search on saved name, own WhatsApp name or number; one row per phone number, best match first. */
export async function searchContacts(userId: string, q: string, limit = 15): Promise<ContactHit[]> {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return [];
  const digits = q.replace(/\D/g, '');
  const vals: unknown[] = [userId];
  const conds = words.map((w) => {
    vals.push(`%${w.replace(/[%_\\]/g, '\\$&')}%`);
    return `(COALESCE(name, '') ILIKE $${vals.length} OR COALESCE(notify, '') ILIKE $${vals.length})`;
  });
  let where = conds.join(' AND ');
  if (digits.length >= 4) { vals.push(`%${digits}%`); where = `(${where}) OR phone LIKE $${vals.length}`; }
  const r = await query<{ name: string | null; notify: string | null; phone: string }>(
    `SELECT DISTINCT ON (phone) name, notify, phone FROM whatsapp_contacts
      WHERE user_id = $1 AND phone IS NOT NULL AND (${where})
      ORDER BY phone, (name IS NULL), updated_at DESC LIMIT 200`, vals);
  // rank outside SQL: exact name first, then names that start with the query
  const ql = q.trim().toLowerCase();
  const score = (h: { name: string | null; notify: string | null }) => {
    const n = (h.name ?? h.notify ?? '').toLowerCase();
    return n === ql ? 0 : n.startsWith(ql) ? 1 : h.name ? 2 : 3;
  };
  return r.rows
    .sort((a, b) => score(a) - score(b))
    .slice(0, limit)
    .map((h) => ({ name: h.name ?? h.notify ?? '', phone: h.phone, notify: h.name && h.notify && h.notify !== h.name ? h.notify : null }));
}

export async function clearContacts(userId: string): Promise<void> {
  await query('DELETE FROM whatsapp_contacts WHERE user_id = $1', [userId]);
}
