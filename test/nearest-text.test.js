import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNearestText,
  extractPlainText,
  extractCaption,
} from '../src/nearest-text.js';

test('caption wins over nearest text', () => {
  const label = resolveNearestText({
    caption: '  the caption  ',
    chatId: 'c1',
    sender: 's1',
    mediaTs: 1000,
    texts: [{ chatId: 'c1', sender: 's1', ts: 990, text: 'earlier' }],
  });
  assert.equal(label, 'the caption');
});

test('nearest prior within 15 msgs / 30 min', () => {
  const mediaTs = 1_000_000;
  const texts = [
    { chatId: 'c1', sender: 's1', ts: mediaTs - 60, text: 'closest prior' },
    { chatId: 'c1', sender: 's1', ts: mediaTs - 120, text: 'older' },
    { chatId: 'c1', sender: 'other', ts: mediaTs - 30, text: 'wrong sender' },
    { chatId: 'c2', sender: 's1', ts: mediaTs - 30, text: 'wrong chat' },
  ];
  assert.equal(
    resolveNearestText({
      caption: null,
      chatId: 'c1',
      sender: 's1',
      mediaTs,
      texts,
      maxMessages: 15,
      maxMinutes: 30,
    }),
    'closest prior',
  );
});

test('ignores text outside 30 minutes', () => {
  const mediaTs = 1_000_000;
  const texts = [
    { chatId: 'c1', sender: 's1', ts: mediaTs - 31 * 60, text: 'too old' },
  ];
  assert.equal(
    resolveNearestText({
      caption: '',
      chatId: 'c1',
      sender: 's1',
      mediaTs,
      texts,
      maxMessages: 15,
      maxMinutes: 30,
    }),
    null,
  );
});

test('falls back to nearest later text in window', () => {
  const mediaTs = 1_000_000;
  const texts = [
    { chatId: 'c1', sender: 's1', ts: mediaTs + 45, text: 'after note' },
  ];
  assert.equal(
    resolveNearestText({
      caption: null,
      chatId: 'c1',
      sender: 's1',
      mediaTs,
      texts,
    }),
    'after note',
  );
});

test('extractPlainText and caption', () => {
  assert.equal(extractPlainText({ conversation: ' hi ' }), 'hi');
  assert.equal(
    extractPlainText({ extendedTextMessage: { text: 'hello' } }),
    'hello',
  );
  assert.equal(extractCaption({ caption: ' shot ' }), 'shot');
  assert.equal(extractCaption({}), null);
});
