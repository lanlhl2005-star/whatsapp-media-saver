/**
 * Assemble caption + same-sender before/after texts for a saved media folder.
 * Window matches nearest-text: maxMessages (default 15) AND maxMinutes (default 30).
 */

import fs from 'node:fs';
import path from 'node:path';
import { formatFolderTimestamp } from './naming.js';

/**
 * @typedef {{ text: string, ts: number, sender: string, chatId: string, messageId?: string|null }} TextEntry
 */

/**
 * @typedef {{
 *   role: 'before'|'caption'|'after',
 *   ts: number,
 *   text: string,
 *   messageId?: string|null
 * }} ContextLine
 */

/**
 * @typedef {{
 *   caption: string|null,
 *   before: TextEntry[],
 *   after: TextEntry[],
 *   lines: ContextLine[],
 *   mediaTs: number,
 *   chatId: string,
 *   sender: string
 * }} MediaContext
 */

/**
 * Deduplicate text entries (prefer messageId; else ts+text+sender).
 * @param {TextEntry[]} entries
 * @returns {TextEntry[]}
 */
export function dedupeTextEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const t of entries || []) {
    if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
    if (!Number.isFinite(t.ts)) continue;
    const key = t.messageId
      ? `id:${t.messageId}`
      : `t:${t.ts}|${t.sender}|${t.text.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      chatId: t.chatId,
      sender: t.sender,
      ts: t.ts,
      text: t.text.trim(),
      messageId: t.messageId ?? null,
    });
  }
  return out;
}

/**
 * Collect caption + before/after same-sender texts in the nearest-text window.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.caption
 * @param {string} opts.chatId
 * @param {string} opts.sender — text-cache sender key (folder segment)
 * @param {number} opts.mediaTs — unix seconds
 * @param {string|null|undefined} [opts.mediaMessageId] — exclude this msg from before/after
 * @param {TextEntry[]} opts.texts
 * @param {number} [opts.maxMessages=15]
 * @param {number} [opts.maxMinutes=30]
 * @returns {MediaContext}
 */
export function assembleMediaContext({
  caption,
  chatId,
  sender,
  mediaTs,
  mediaMessageId,
  texts,
  maxMessages = 15,
  maxMinutes = 30,
}) {
  const cap = (caption || '').trim() || null;
  const maxSec = maxMinutes * 60;
  const mediaId = mediaMessageId || null;

  const same = dedupeTextEntries(texts).filter(
    (t) =>
      t.chatId === chatId &&
      t.sender === sender &&
      (!mediaId || t.messageId !== mediaId),
  );

  const before = same
    .filter((t) => t.ts < mediaTs && mediaTs - t.ts <= maxSec)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, maxMessages)
    .sort((a, b) => a.ts - b.ts || String(a.messageId || '').localeCompare(String(b.messageId || '')));

  const after = same
    .filter((t) => t.ts > mediaTs && t.ts - mediaTs <= maxSec)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, maxMessages);

  /** @type {ContextLine[]} */
  const lines = [];
  for (const t of before) {
    lines.push({ role: 'before', ts: t.ts, text: t.text, messageId: t.messageId });
  }
  if (cap) {
    lines.push({
      role: 'caption',
      ts: mediaTs,
      text: cap,
      messageId: mediaId,
    });
  }
  for (const t of after) {
    lines.push({ role: 'after', ts: t.ts, text: t.text, messageId: t.messageId });
  }

  return {
    caption: cap,
    before,
    after,
    lines,
    mediaTs,
    chatId,
    sender,
  };
}

/**
 * Format a unix-seconds timestamp for description.txt (Asia/Hong_Kong by default).
 * @param {number} ts
 * @param {string} [timeZone]
 */
export function formatContextTimestamp(ts, timeZone = 'Asia/Hong_Kong') {
  // Reuse folder stamp shape: YYYY-MM-DD_HH-MM-SS
  return formatFolderTimestamp(ts, timeZone);
}

/**
 * Human-readable UTF-8 description for Explorer.
 * @param {MediaContext} ctx
 * @param {{ timeZone?: string, mediaFile?: string|null }} [opts]
 * @returns {string}
 */
export function formatDescriptionTxt(ctx, opts = {}) {
  const timeZone = opts.timeZone || 'Asia/Hong_Kong';
  const mediaFile = opts.mediaFile || null;
  const header = [
    'WhatsApp media description / context',
    `Sender: ${ctx.sender}`,
    `Chat: ${ctx.chatId}`,
    `Media time: ${formatContextTimestamp(ctx.mediaTs, timeZone)}`,
  ];
  if (mediaFile) header.push(`Media file: ${mediaFile}`);
  header.push('Window: same sender · 15 messages or 30 minutes · before & after');
  header.push('');

  if (!ctx.lines.length) {
    return `${header.join('\n')}(no caption or surrounding text in window)\n`;
  }

  const body = ctx.lines.map((line) => {
    const stamp = formatContextTimestamp(line.ts, timeZone);
    return `[${stamp}] (${line.role}) ${line.text}`;
  });

  return `${header.join('\n')}${body.join('\n')}\n`;
}

/**
 * Structured sidecar payload.
 * @param {MediaContext} ctx
 * @param {{ mediaFile?: string|null, mediaType?: string|null, folderPath?: string|null }} [extra]
 */
export function buildMetaJson(ctx, extra = {}) {
  return {
    mediaTs: ctx.mediaTs,
    chatId: ctx.chatId,
    sender: ctx.sender,
    caption: ctx.caption,
    mediaFile: extra.mediaFile ?? null,
    mediaType: extra.mediaType ?? null,
    folderPath: extra.folderPath ?? null,
    before: ctx.before.map((t) => ({
      ts: t.ts,
      text: t.text,
      messageId: t.messageId ?? null,
    })),
    after: ctx.after.map((t) => ({
      ts: t.ts,
      text: t.text,
      messageId: t.messageId ?? null,
    })),
    lines: ctx.lines,
  };
}

/**
 * Write description.txt + meta.json into the per-media folder (UTF-8).
 * Idempotent overwrite — safe to refresh when later context arrives.
 *
 * @param {string} absoluteFolder
 * @param {MediaContext} ctx
 * @param {{ timeZone?: string, mediaFile?: string|null, mediaType?: string|null, folderPath?: string|null }} [opts]
 * @returns {{ descriptionPath: string, metaPath: string, wrote: boolean }}
 */
export function writeMediaContextFiles(absoluteFolder, ctx, opts = {}) {
  fs.mkdirSync(absoluteFolder, { recursive: true });
  const descriptionPath = path.join(absoluteFolder, 'description.txt');
  const metaPath = path.join(absoluteFolder, 'meta.json');
  const txt = formatDescriptionTxt(ctx, {
    timeZone: opts.timeZone,
    mediaFile: opts.mediaFile,
  });
  const meta = buildMetaJson(ctx, {
    mediaFile: opts.mediaFile,
    mediaType: opts.mediaType,
    folderPath: opts.folderPath,
  });
  fs.writeFileSync(descriptionPath, txt, 'utf8');
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { descriptionPath, metaPath, wrote: true };
}

/**
 * True when context has anything useful to persist.
 * @param {MediaContext} ctx
 */
export function hasContextContent(ctx) {
  return Boolean(ctx?.caption || ctx?.before?.length || ctx?.after?.length);
}
