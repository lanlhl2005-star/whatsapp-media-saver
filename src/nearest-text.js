/**
 * Resolve nearest same-sender text for caption-less media.
 * Window: maxMessages OR maxMinutes (whichever bound is hit first conceptually —
 * both constraints must be satisfied: within last N cached texts AND within T minutes).
 */

/**
 * @typedef {{ text: string, ts: number, sender: string, chatId: string }} TextEntry
 *   ts is unix seconds (WhatsApp style)
 */

/**
 * Pick the best naming text for a media message.
 * Prefers caption; else nearest prior same-sender text in-chat within window;
 * else nearest later text in a short after-window (same constraints).
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.caption
 * @param {string} opts.chatId
 * @param {string} opts.sender
 * @param {number} opts.mediaTs — unix seconds
 * @param {TextEntry[]} opts.texts — cached texts (any order)
 * @param {number} [opts.maxMessages=15]
 * @param {number} [opts.maxMinutes=30]
 * @returns {string|null}
 */
export function resolveNearestText({
  caption,
  chatId,
  sender,
  mediaTs,
  texts,
  maxMessages = 15,
  maxMinutes = 30,
}) {
  const cap = (caption || '').trim();
  if (cap) return cap;

  const maxSec = maxMinutes * 60;
  const same = (texts || []).filter(
    (t) =>
      t &&
      t.chatId === chatId &&
      t.sender === sender &&
      typeof t.text === 'string' &&
      t.text.trim() &&
      Number.isFinite(t.ts),
  );

  const prior = same
    .filter((t) => t.ts <= mediaTs && mediaTs - t.ts <= maxSec)
    .sort((a, b) => {
      // Prefer closest earlier (largest ts), then among equals keep stable by original order via index
      return b.ts - a.ts;
    })
    .slice(0, maxMessages);

  if (prior.length) return prior[0].text.trim();

  const after = same
    .filter((t) => t.ts > mediaTs && t.ts - mediaTs <= maxSec)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, maxMessages);

  if (after.length) return after[0].text.trim();
  return null;
}

/**
 * Extract plain conversation text from a Baileys message content object (best-effort).
 * @param {object|null|undefined} message
 */
export function extractPlainText(message) {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.conversation === 'string' && message.conversation.trim()) {
    return message.conversation.trim();
  }
  const ext = message.extendedTextMessage;
  if (ext && typeof ext.text === 'string' && ext.text.trim()) {
    return ext.text.trim();
  }
  // Captions live on media — callers may use those separately
  return null;
}

/**
 * Extract caption / title from a media content payload (image/video/document).
 * Documents often carry `title` when `caption` is empty.
 */
export function extractCaption(mediaContent) {
  if (!mediaContent || typeof mediaContent !== 'object') return null;
  for (const key of ['caption', 'title']) {
    const cap = mediaContent[key];
    if (typeof cap === 'string' && cap.trim()) return cap.trim();
  }
  return null;
}

/**
 * Stem from an original WhatsApp fileName (sans directory / extension).
 * Used when caption and nearest-text are missing (common for documents).
 * @param {string|null|undefined} fileName
 * @returns {string|null}
 */
export function stemFromOriginalFileName(fileName) {
  if (!fileName) return null;
  const base = String(fileName).split(/[\\/]/).pop() || '';
  if (!base.trim()) return null;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem || null;
}

/**
 * Pick a file label: caption / nearest text, else original document/image fileName stem.
 */
export function resolveFileLabel({
  caption,
  chatId,
  sender,
  mediaTs,
  texts,
  maxMessages = 15,
  maxMinutes = 30,
  originalFileName,
}) {
  const fromText = resolveNearestText({
    caption,
    chatId,
    sender,
    mediaTs,
    texts,
    maxMessages,
    maxMinutes,
  });
  if (fromText) return fromText;
  return stemFromOriginalFileName(originalFileName);
}
