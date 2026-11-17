import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMessage,
  shouldSaveMediaKind,
  unwrapMessage,
} from '../src/media-types.js';

test('classifies image/video/document as saveable', () => {
  assert.equal(classifyMessage({ imageMessage: { mimetype: 'image/jpeg' } }).kind, 'image');
  assert.equal(classifyMessage({ videoMessage: { mimetype: 'video/mp4' } }).kind, 'video');
  assert.equal(
    classifyMessage({ documentMessage: { fileName: 'a.pdf' } }).kind,
    'document',
  );
  assert.equal(shouldSaveMediaKind('image'), true);
  assert.equal(shouldSaveMediaKind('video'), true);
  assert.equal(shouldSaveMediaKind('document'), true);
});

test('skips audio, ptt, sticker', () => {
  assert.equal(classifyMessage({ audioMessage: { ptt: false } }).kind, 'audio');
  assert.equal(classifyMessage({ audioMessage: { ptt: true } }).kind, 'ptt');
  assert.equal(classifyMessage({ stickerMessage: {} }).kind, 'sticker');
  assert.equal(shouldSaveMediaKind('audio'), false);
  assert.equal(shouldSaveMediaKind('ptt'), false);
  assert.equal(shouldSaveMediaKind('sticker'), false);
});

test('unwraps ephemeral / view-once', () => {
  const inner = { imageMessage: { mimetype: 'image/png' } };
  const wrapped = { ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } };
  assert.equal(unwrapMessage(wrapped).imageMessage.mimetype, 'image/png');
  assert.equal(classifyMessage(wrapped).kind, 'image');
});
