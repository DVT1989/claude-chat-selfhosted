// Integration: real database, one throwaway user removed afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../db';
import { ensureContactsSchema, phoneOfJid, saveContacts, savePhoneForLid, searchContacts, countContacts, clearContacts } from './contacts';

let userId: string;
before(async () => {
  await ensureContactsSchema();
  userId = (await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'wa-contacts-test') RETURNING id`,
    [`wa-contacts-${Date.now()}@test.local`])).rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
});

test('phoneOfJid', () => {
  assert.equal(phoneOfJid('31612345678@s.whatsapp.net'), '31612345678');
  assert.equal(phoneOfJid('31612345678:3@s.whatsapp.net'), '31612345678');
  assert.equal(phoneOfJid('123456789012345@lid'), null);
  assert.equal(phoneOfJid(null), null);
});

test('save, merge, LID numbers, search and clear', async () => {
  await saveContacts(userId, [
    { jid: '31611111111@s.whatsapp.net', lid: null, phone: '31611111111', name: 'Jan Jansen', notify: null },
    { jid: '31622222222@s.whatsapp.net', lid: null, phone: '31622222222', name: 'Jan de Vries', notify: null },
    { jid: '99999@lid', lid: '99999@lid', phone: null, name: 'Anna', notify: null },
    { jid: '120363@g.us', lid: null, phone: null, name: 'Een groep', notify: null },
  ]);
  // a push name later must not wipe the saved name
  await saveContacts(userId, [{ jid: '31611111111@s.whatsapp.net', lid: null, phone: null, name: null, notify: 'Jantje' }]);
  assert.deepEqual(await countContacts(userId), { total: 2, named: 2 });
  await savePhoneForLid(userId, '99999@lid', '31633333333');
  assert.deepEqual(await countContacts(userId), { total: 3, named: 3 });

  const hits = await searchContacts(userId, 'jan jansen');
  assert.deepEqual(hits, [{ name: 'Jan Jansen', phone: '31611111111', notify: 'Jantje' }]);
  assert.equal((await searchContacts(userId, 'jan')).length, 2);
  assert.equal((await searchContacts(userId, 'tijn'))[0].phone, '31611111111');
  assert.equal((await searchContacts(userId, '0633333'))[0]?.name, undefined); // 06 is not stored as such
  assert.equal((await searchContacts(userId, '33333333'))[0].name, 'Anna');
  assert.equal((await searchContacts(userId, '%')).length, 0);

  await clearContacts(userId);
  assert.deepEqual(await countContacts(userId), { total: 0, named: 0 });
});
