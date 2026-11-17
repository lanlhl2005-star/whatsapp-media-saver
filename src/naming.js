/**
 * Pure naming helpers — folder/file sanitize, GMT+0800 folder stamps, collisions.
 */

const FOLDER_TZ = 'Asia/Hong_Kong';
const STEM_MAX = 160;

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

/**
 * Sanitize a filesystem stem (NFC, strip reserved chars, collapse whitespace).
 * @param {string} input
 * @param {{ maxLength?: number }} [opts]
 */
export function sanitizeStem(input, opts = {}) {
  const maxLength = opts.maxLength ?? STEM_MAX;
  let s = String(input ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\/\\:\*\?"<>\|]/g, '-');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/\.+/g, '.');
  s = s.replace(/^[\s.\-_]+|[\s.\-_]+$/g, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/[\s.\-_]+$/g, '');
  return s;
}

/**
 * Sanitize a group covering-folder name.
 */
export function sanitizeGroupName(name) {
  const cleaned = sanitizeStem(name || 'unknown-group', { maxLength: 80 });
  return cleaned || 'unknown-group';
}

/**
 * Normalize a phone/JID fragment to +E164 digits when possible.
 * @param {string|null|undefined} raw
 */
export function normalizePhone(raw) {
  if (!raw) return 'unknown';
  let s = String(raw).trim();
  // Strip WhatsApp JID domain
  if (s.includes('@')) s = s.split('@')[0];
  // Device / agent suffixes like 123:45 or LID
  if (s.includes(':')) s = s.split(':')[0];
  if (/^lid$/i.test(s) || !s) return 'unknown';
  const digits = s.replace(/\D/g, '');
  if (!digits) {
    const slug = sanitizeStem(s, { maxLength: 40 });
    return slug ? `jid_${slug}` : 'unknown';
  }
  return `+${digits}`;
}

/**
 * Format message timestamp as YYYY-MM-DD_HH-MM-SS in Asia/Hong_Kong.
 * @param {number|Date} when — Date or unix seconds/ms
 */
export function formatFolderTimestamp(when, timeZone = FOLDER_TZ) {
  const d = toDate(when);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}-${get('second')}`;
}

function toDate(when) {
  if (when instanceof Date) return when;
  const n = Number(when);
  if (!Number.isFinite(n)) return new Date();
  // WhatsApp message timestamps are usually seconds
  return new Date(n < 1e12 ? n * 1000 : n);
}

/**
 * Per-media folder name: YYYY-MM-DD_HH-MM-SS_+E164
 */
export function buildPerMediaFolderName(when, phoneOrJid, timeZone = FOLDER_TZ) {
  const ts = formatFolderTimestamp(when, timeZone);
  const phone = normalizePhone(phoneOrJid);
  return `${ts}_${phone}`;
}

/**
 * Map MIME / original filename → extension (with leading dot).
 */
export function extensionFromMeta({ mimetype, fileName, mediaType } = {}) {
  if (fileName) {
    const base = String(fileName).split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot > 0 && dot < base.length - 1) {
      const ext = base.slice(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,12}$/i.test(ext)) return ext;
    }
  }
  if (mimetype && MIME_TO_EXT[mimetype.toLowerCase()]) {
    return MIME_TO_EXT[mimetype.toLowerCase()];
  }
  if (mediaType === 'image') return '.jpg';
  if (mediaType === 'video') return '.mp4';
  if (mediaType === 'document') return '.bin';
  return '.bin';
}

/**
 * Build sanitized file stem from caption / nearest text / fallback id.
 */
export function buildFileStem(label, shortMsgId) {
  const cleaned = sanitizeStem(label || '');
  if (cleaned) return cleaned;
  const id = sanitizeStem(shortMsgId || 'unknown', { maxLength: 24 }) || 'unknown';
  return `media-${id}`;
}

/**
 * Resolve a collision-safe file path basename: name.ext, name__2.ext, …
 * @param {string} stem
 * @param {string} ext — with leading dot
 * @param {(name: string) => boolean} existsFn — true if basename already taken
 */
export function nextAvailableFileName(stem, ext, existsFn) {
  const safeExt = ext?.startsWith('.') ? ext : `.${ext || 'bin'}`;
  let candidate = `${stem}${safeExt}`;
  if (!existsFn(candidate)) return candidate;
  for (let i = 2; i < 10_000; i++) {
    candidate = `${stem}__${i}${safeExt}`;
    if (!existsFn(candidate)) return candidate;
  }
  throw new Error('Too many filename collisions');
}

/**
 * Relative destination path parts under SAVE_ROOT.
 * Groups: [groupName, perMediaFolder, fileName]
 * 1:1:    [perMediaFolder, fileName]
 */
export function buildRelativeParts({
  isGroup,
  groupName,
  when,
  senderPhone,
  fileLabel,
  shortMsgId,
  mimetype,
  originalFileName,
  mediaType,
  timeZone = FOLDER_TZ,
  existsInFolder,
}) {
  const perMedia = buildPerMediaFolderName(when, senderPhone, timeZone);
  const stem = buildFileStem(fileLabel, shortMsgId);
  const ext = extensionFromMeta({
    mimetype,
    fileName: originalFileName,
    mediaType,
  });
  const fileName = nextAvailableFileName(stem, ext, existsInFolder || (() => false));

  if (isGroup) {
    const covering = sanitizeGroupName(groupName);
    return {
      parts: [covering, perMedia, fileName],
      covering,
      perMediaFolder: perMedia,
      fileName,
      stem,
      ext,
    };
  }
  return {
    parts: [perMedia, fileName],
    covering: null,
    perMediaFolder: perMedia,
    fileName,
    stem,
    ext,
  };
}
