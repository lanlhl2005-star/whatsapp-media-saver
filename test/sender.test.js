import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLidPhoneCache,
  pickPreferredSenderJid,
  resolveFolderSender,
  resolveLidToPhoneJid,
  senderJidCandidates,
  textCacheSenderKey,
} from '../src/sender.js';
import { folderSenderSegment } from '../src/naming.js';

test('senderJidCandidates prefer participantPn / senderPn over LID', () => {
  const group = {
    key: {
      remoteJid: '120363@g.us',
      participant: '157161527226406@lid',
      participantPn: '85291234567@s.whatsapp.net',
    },
  };
  assert.deepEqual(senderJidCandidates(group), [
    '85291234567@s.whatsapp.net',
    '157161527226406@lid',
  ]);

  const dm = {
    key: {
      remoteJid: '157161527226406@lid',
      senderPn: '85298765432@s.whatsapp.net',
    },
  };
  assert.deepEqual(senderJidCandidates(dm), [
    '85298765432@s.whatsapp.net',
    '157161527226406@lid',
  ]);
});

test('pickPreferredSenderJid picks phone over LID', () => {
  const msg = {
    key: {
      remoteJid: '157161527226406@lid',
      senderPn: '85291234567@s.whatsapp.net',
    },
  };
  assert.equal(pickPreferredSenderJid(msg), '85291234567@s.whatsapp.net');
});

test('resolveFolderSender uses phone JID for folder segment', async () => {
  const msg = {
    key: {
      remoteJid: '157161527226406@lid',
      senderPn: '85291234567@s.whatsapp.net',
    },
  };
  const resolved = await resolveFolderSender(msg, null, createLidPhoneCache());
  assert.equal(resolved.folderSender, '+85291234567');
  assert.equal(resolved.phoneJid, '85291234567@s.whatsapp.net');
  assert.equal(folderSenderSegment(resolved.phoneJid), '+85291234567');
});

test('resolveFolderSender falls back to lid_<id> never +lidDigits', async () => {
  const msg = {
    key: { remoteJid: '157161527226406@lid' },
  };
  const resolved = await resolveFolderSender(msg, null, createLidPhoneCache());
  assert.equal(resolved.folderSender, 'lid_157161527226406');
  assert.equal(resolved.folderSender.startsWith('+'), false);
  assert.match(resolved.folderSender, /^lid_/);
});

test('lid cache + signalRepository.lidMapping resolve PN', async () => {
  const cache = createLidPhoneCache();
  cache.remember('157161527226406@lid', '85211112222@s.whatsapp.net');
  assert.equal(
    await resolveLidToPhoneJid('157161527226406@lid', null, cache),
    '85211112222@s.whatsapp.net',
  );

  const sock = {
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          assert.equal(lid, '999@lid');
          return '85300001111@s.whatsapp.net';
        },
      },
    },
  };
  const fresh = createLidPhoneCache();
  assert.equal(
    await resolveLidToPhoneJid('999@lid', sock, fresh),
    '85300001111@s.whatsapp.net',
  );
  // cached after mapping lookup
  assert.equal(
    await resolveLidToPhoneJid('999@lid', null, fresh),
    '85300001111@s.whatsapp.net',
  );
});

test('contacts.upsert-shaped contact fills cache', async () => {
  const cache = createLidPhoneCache();
  cache.rememberContact({
    id: '85255556666@s.whatsapp.net',
    lid: '111222333@lid',
    jid: '85255556666@s.whatsapp.net',
  });
  const msg = { key: { remoteJid: '111222333@lid' } };
  const resolved = await resolveFolderSender(msg, null, cache);
  assert.equal(resolved.folderSender, '+85255556666');
});

test('textCacheSenderKey stable for phone folder segment', () => {
  assert.equal(textCacheSenderKey('+85291234567', 'x@lid'), '+85291234567');
  assert.equal(
    textCacheSenderKey('unknown', '157161527226406@lid'),
    'lid_157161527226406',
  );
});
