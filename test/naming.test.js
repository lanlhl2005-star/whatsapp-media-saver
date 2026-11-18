import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeStem,
  sanitizeGroupName,
  normalizePhone,
  folderSenderSegment,
  isLidJid,
  isPhoneJid,
  formatFolderTimestamp,
  buildPerMediaFolderName,
  extensionFromMeta,
  buildFileStem,
  nextAvailableFileName,
  buildRelativeParts,
} from '../src/naming.js';

test('sanitizeStem strips reserved chars and collapses whitespace', () => {
  assert.equal(sanitizeStem('  invoice/october:final?.pdf  '), 'invoice-october-final-.pdf');
  assert.equal(sanitizeStem('a\\b|c*"<>'), 'a-b-c');
  assert.equal(sanitizeStem(''), '');
});

test('sanitizeGroupName falls back', () => {
  assert.equal(sanitizeGroupName('Project Alpha'), 'Project-Alpha');
  assert.equal(sanitizeGroupName(''), 'unknown-group');
  assert.equal(sanitizeGroupName(':::'), 'unknown-group');
});

test('normalizePhone / folderSenderSegment phone vs LID', () => {
  assert.equal(normalizePhone('85291234567@s.whatsapp.net'), '+85291234567');
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('12345:99@s.whatsapp.net'), '+12345');
  assert.equal(normalizePhone(null), 'unknown');
  // LID must never become +digits pretending to be E.164
  assert.equal(
    folderSenderSegment('157161527226406@lid'),
    'lid_157161527226406',
  );
  assert.equal(
    normalizePhone('157161527226406@lid'),
    'lid_157161527226406',
  );
  assert.equal(folderSenderSegment('999@hosted.lid'), 'lid_999');
  assert.equal(isLidJid('157161527226406@lid'), true);
  assert.equal(isPhoneJid('85291234567@s.whatsapp.net'), true);
  assert.equal(isPhoneJid('157161527226406@lid'), false);
});

test('buildPerMediaFolderName uses lid_ fallback for LID JID', () => {
  const utc = Date.UTC(2026, 10, 18, 2, 6, 15); // 10:06:15 HKT
  assert.equal(
    buildPerMediaFolderName(utc, '157161527226406@lid'),
    '2026-11-18_10-06-15_lid_157161527226406',
  );
});

test('formatFolderTimestamp always Asia/Hong_Kong', () => {
  // 2026-11-17 01:15:03 UTC → 09:15:03 HKT (UTC+8)
  const utc = Date.UTC(2026, 10, 17, 1, 15, 3);
  assert.equal(formatFolderTimestamp(utc), '2026-11-17_09-15-03');
  // unix seconds
  assert.equal(formatFolderTimestamp(Math.floor(utc / 1000)), '2026-11-17_09-15-03');
});

test('buildPerMediaFolderName', () => {
  const utc = Date.UTC(2026, 10, 17, 1, 15, 3);
  assert.equal(
    buildPerMediaFolderName(utc, '85291234567@s.whatsapp.net'),
    '2026-11-17_09-15-03_+85291234567',
  );
});

test('extensionFromMeta', () => {
  assert.equal(extensionFromMeta({ fileName: 'Report.PDF' }), '.pdf');
  assert.equal(extensionFromMeta({ mimetype: 'image/jpeg' }), '.jpg');
  assert.equal(extensionFromMeta({ mediaType: 'video' }), '.mp4');
});

test('buildFileStem fallback', () => {
  assert.equal(buildFileStem('Family dinner!', 'abc12345'), 'Family-dinner!');
  assert.equal(buildFileStem('', 'abc12345'), 'media-abc12345');
  assert.equal(buildFileStem('***', 'zz'), 'media-zz');
});

test('nextAvailableFileName collision __2', () => {
  const taken = new Set(['family-dinner.jpg']);
  assert.equal(
    nextAvailableFileName('family-dinner', '.jpg', (n) => taken.has(n)),
    'family-dinner__2.jpg',
  );
  taken.add('family-dinner__2.jpg');
  assert.equal(
    nextAvailableFileName('family-dinner', '.jpg', (n) => taken.has(n)),
    'family-dinner__3.jpg',
  );
});

test('buildRelativeParts group vs 1:1', () => {
  const when = Date.UTC(2026, 10, 17, 6, 5, 1); // 14:05:01 HKT
  const oneToOne = buildRelativeParts({
    isGroup: false,
    when,
    senderPhone: '+85291234567',
    fileLabel: 'invoice october',
    shortMsgId: 'abcd',
    mimetype: 'application/pdf',
  });
  assert.deepEqual(oneToOne.parts, [
    '2026-11-17_14-05-01_+85291234567',
    'invoice-october.pdf',
  ]);

  const group = buildRelativeParts({
    isGroup: true,
    groupName: 'Project Alpha',
    when,
    senderPhone: '+85291234567',
    fileLabel: 'family dinner',
    shortMsgId: 'abcd',
    mimetype: 'image/jpeg',
  });
  assert.deepEqual(group.parts, [
    'Project-Alpha',
    '2026-11-17_14-05-01_+85291234567',
    'family-dinner.jpg',
  ]);
});
