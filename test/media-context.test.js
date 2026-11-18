import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assembleMediaContext,
  dedupeTextEntries,
  formatContextWindowLabel,
  formatDescriptionTxt,
  buildMetaJson,
  hasContextContent,
  writeMediaContextFiles,
  DEFAULT_CONTEXT_MAX_MESSAGES,
  DEFAULT_CONTEXT_MAX_MINUTES,
} from '../src/media-context.js';

const mediaTs = 1_700_000_000;

function texts(list) {
  return list.map((t) => ({
    chatId: 'c1',
    sender: '+85291234567',
    ...t,
  }));
}

test('defaults are ±15 min / 5 per side', () => {
  assert.equal(DEFAULT_CONTEXT_MAX_MESSAGES, 5);
  assert.equal(DEFAULT_CONTEXT_MAX_MINUTES, 15);
  assert.match(
    formatContextWindowLabel(),
    /±15 minutes · at most 5 texts before & 5 after/,
  );
});

test('assembleMediaContext: caption + chronological before/after', () => {
  const ctx = assembleMediaContext({
    caption: '  the photo  ',
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    mediaMessageId: 'media1',
    texts: texts([
      { ts: mediaTs - 120, text: 'older note', messageId: 't1' },
      { ts: mediaTs - 30, text: 'see this', messageId: 't2' },
      { ts: mediaTs, text: 'the photo', messageId: 'media1' }, // same media caption in cache
      { ts: mediaTs + 20, text: 'more detail', messageId: 't3' },
      { ts: mediaTs + 40, text: 'thanks', messageId: 't4' },
      { chatId: 'c1', sender: 'other', ts: mediaTs - 10, text: 'wrong sender' },
      { chatId: 'c2', sender: '+85291234567', ts: mediaTs - 10, text: 'wrong chat' },
    ]),
  });

  assert.equal(ctx.caption, 'the photo');
  assert.equal(ctx.maxMessages, 5);
  assert.equal(ctx.maxMinutes, 15);
  assert.deepEqual(
    ctx.before.map((t) => t.text),
    ['older note', 'see this'],
  );
  assert.deepEqual(
    ctx.after.map((t) => t.text),
    ['more detail', 'thanks'],
  );
  assert.deepEqual(
    ctx.lines.map((l) => [l.role, l.text]),
    [
      ['before', 'older note'],
      ['before', 'see this'],
      ['caption', 'the photo'],
      ['after', 'more detail'],
      ['after', 'thanks'],
    ],
  );
  // Own media caption must not also appear as before/after
  assert.ok(!ctx.before.some((t) => t.messageId === 'media1'));
  assert.ok(!ctx.after.some((t) => t.messageId === 'media1'));
});

test('assembleMediaContext: respects 15-minute window', () => {
  const ctx = assembleMediaContext({
    caption: null,
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    texts: texts([
      { ts: mediaTs - 16 * 60, text: 'too old', messageId: 'old' },
      { ts: mediaTs - 60, text: 'in window', messageId: 'ok' },
      { ts: mediaTs + 16 * 60, text: 'too late', messageId: 'late' },
      { ts: mediaTs + 10 * 60, text: 'after ok', messageId: 'lateok' },
    ]),
  });
  assert.deepEqual(
    ctx.before.map((t) => t.text),
    ['in window'],
  );
  assert.deepEqual(
    ctx.after.map((t) => t.text),
    ['after ok'],
  );
  assert.equal(hasContextContent(ctx), true);
});

test('assembleMediaContext: still includes edge of ±15 minutes', () => {
  const ctx = assembleMediaContext({
    caption: null,
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    texts: texts([
      { ts: mediaTs - 15 * 60, text: 'edge before', messageId: 'eb' },
      { ts: mediaTs + 15 * 60, text: 'edge after', messageId: 'ea' },
    ]),
  });
  assert.deepEqual(
    ctx.before.map((t) => t.text),
    ['edge before'],
  );
  assert.deepEqual(
    ctx.after.map((t) => t.text),
    ['edge after'],
  );
});

test('assembleMediaContext: caps before/after at maxMessages (closest)', () => {
  const beforeMany = [];
  for (let i = 1; i <= 20; i++) {
    beforeMany.push({
      ts: mediaTs - i * 10,
      text: `b${i}`,
      messageId: `b${i}`,
    });
  }
  const ctx = assembleMediaContext({
    caption: null,
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    texts: texts(beforeMany),
    maxMessages: 5,
    maxMinutes: 15,
  });
  // Closest 5 priors, then chronological
  assert.deepEqual(
    ctx.before.map((t) => t.text),
    ['b5', 'b4', 'b3', 'b2', 'b1'],
  );
});

test('assembleMediaContext: default cap is 5 per side', () => {
  const beforeMany = [];
  const afterMany = [];
  for (let i = 1; i <= 8; i++) {
    beforeMany.push({
      ts: mediaTs - i * 10,
      text: `b${i}`,
      messageId: `b${i}`,
    });
    afterMany.push({
      ts: mediaTs + i * 10,
      text: `a${i}`,
      messageId: `a${i}`,
    });
  }
  const ctx = assembleMediaContext({
    caption: 'cap',
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    texts: texts([...beforeMany, ...afterMany]),
  });
  assert.equal(ctx.before.length, 5);
  assert.equal(ctx.after.length, 5);
  assert.deepEqual(
    ctx.before.map((t) => t.text),
    ['b5', 'b4', 'b3', 'b2', 'b1'],
  );
  assert.deepEqual(
    ctx.after.map((t) => t.text),
    ['a1', 'a2', 'a3', 'a4', 'a5'],
  );
});

test('dedupeTextEntries prefers messageId', () => {
  const out = dedupeTextEntries([
    { chatId: 'c1', sender: 's', ts: 1, text: 'hi', messageId: 'm1' },
    { chatId: 'c1', sender: 's', ts: 1, text: 'hi', messageId: 'm1' },
    { chatId: 'c1', sender: 's', ts: 2, text: 'yo', messageId: null },
    { chatId: 'c1', sender: 's', ts: 2, text: 'yo', messageId: null },
  ]);
  assert.equal(out.length, 2);
});

test('formatDescriptionTxt lists chronological roles with timestamps', () => {
  const ctx = assembleMediaContext({
    caption: 'shot',
    chatId: 'c1',
    sender: '+85291234567',
    mediaTs,
    texts: texts([
      { ts: mediaTs - 60, text: 'before note', messageId: 'a' },
      { ts: mediaTs + 30, text: 'after note', messageId: 'b' },
    ]),
  });
  const txt = formatDescriptionTxt(ctx, {
    timeZone: 'Asia/Hong_Kong',
    mediaFile: 'shot.jpg',
  });
  assert.match(txt, /Media file: shot\.jpg/);
  assert.match(txt, /±15 minutes · at most 5 texts before & 5 after/);
  assert.match(txt, /\(before\) before note/);
  assert.match(txt, /\(caption\) shot/);
  assert.match(txt, /\(after\) after note/);
  // before appears before caption appears before after
  const iBefore = txt.indexOf('(before)');
  const iCap = txt.indexOf('(caption)');
  const iAfter = txt.indexOf('(after)');
  assert.ok(iBefore < iCap && iCap < iAfter);
});

test('writeMediaContextFiles writes UTF-8 description.txt and meta.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-ctx-'));
  try {
    const ctx = assembleMediaContext({
      caption: '發票十月',
      chatId: 'c1',
      sender: '+85291234567',
      mediaTs,
      texts: texts([{ ts: mediaTs - 10, text: '請查收', messageId: 'x' }]),
    });
    const result = writeMediaContextFiles(dir, ctx, {
      mediaFile: '發票十月.jpg',
      mediaType: 'image',
      folderPath: '2026-11-18_12-00-00_+85291234567',
    });
    assert.equal(path.basename(result.descriptionPath), 'description.txt');
    assert.equal(path.basename(result.metaPath), 'meta.json');
    const txt = fs.readFileSync(result.descriptionPath, 'utf8');
    assert.match(txt, /請查收/);
    assert.match(txt, /發票十月/);
    const meta = JSON.parse(fs.readFileSync(result.metaPath, 'utf8'));
    assert.equal(meta.caption, '發票十月');
    assert.equal(meta.before[0].text, '請查收');
    assert.equal(meta.mediaFile, '發票十月.jpg');
    assert.equal(meta.maxMessages, 5);
    assert.equal(meta.maxMinutes, 15);
    const built = buildMetaJson(ctx, { mediaFile: 'x.jpg' });
    assert.equal(built.mediaFile, 'x.jpg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasContextContent false when empty', () => {
  const ctx = assembleMediaContext({
    caption: '  ',
    chatId: 'c1',
    sender: 's',
    mediaTs,
    texts: [],
  });
  assert.equal(hasContextContent(ctx), false);
});
