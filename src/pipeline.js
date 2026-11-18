import fs from 'node:fs';
import path from 'node:path';
import {
  buildMsgKey,
  getProcessed,
  upsertProcessed,
  insertTextCache,
  listRecentTexts,
  pruneTextCache,
  setMeta,
  getMeta,
} from './db.js';
import { classifyMessage, shouldSaveMediaKind } from './media-types.js';
import {
  extractCaption,
  extractPlainText,
  resolveFileLabel,
} from './nearest-text.js';
import {
  nextAvailableFileName,
  buildFileStem,
  extensionFromMeta,
} from './naming.js';
import { resolveDestination } from './paths.js';
import { downloadToFile } from './session.js';
import { createDownloadQueue } from './download-queue.js';
import { touchHeartbeat } from './heartbeat.js';
import {
  createLidPhoneCache,
  jidIsGroup,
  pickPreferredSenderJid,
  resolveFolderSender,
  textCacheSenderKey,
} from './sender.js';

/**
 * In-memory ring of recent texts (also persisted to SQLite).
 */
function createTextWindow(maxPerChat = 200) {
  /** @type {Map<string, object[]>} */
  const byChat = new Map();

  return {
    push(entry) {
      const list = byChat.get(entry.chatId) || [];
      list.push(entry);
      if (list.length > maxPerChat) list.splice(0, list.length - maxPerChat);
      byChat.set(entry.chatId, list);
    },
    list(chatId) {
      return byChat.get(chatId) || [];
    },
  };
}

function messageTs(msg) {
  const t = Number(msg.messageTimestamp);
  if (Number.isFinite(t)) return t < 1e12 ? t : Math.floor(t / 1000);
  return Math.floor(Date.now() / 1000);
}

/**
 * @param {object} ctx
 */
export function createPipeline(ctx) {
  const {
    config,
    db,
    sock,
    logger,
    saveRoot,
    tmpDir,
  } = ctx;

  const queue = createDownloadQueue({
    concurrency: config.maxConcurrentDownloads || 2,
    logger,
  });
  const textWindow = createTextWindow();
  const lidPhoneCache = createLidPhoneCache();
  /** @type {Map<string, string>} chatJid -> group subject */
  const groupNames = new Map();
  let catchingUp = false;

  async function refreshGroupName(jid) {
    if (!jidIsGroup(jid)) return null;
    if (groupNames.has(jid)) return groupNames.get(jid);
    try {
      const meta = await sock.groupMetadata(jid);
      const subject = meta?.subject || jid;
      groupNames.set(jid, subject);
      return subject;
    } catch (err) {
      logger.warn({ jid, err: err.message }, 'Could not fetch group metadata');
      const fallback = `group_${jid.split('@')[0]}`;
      groupNames.set(jid, fallback);
      return fallback;
    }
  }

  async function rememberText(msg) {
    const key = msg.key || {};
    if (key.fromMe) return;
    const classified = classifyMessage(msg.message);
    let text = null;
    if (classified.kind === 'text') {
      text = extractPlainText(classified.content);
    } else if (classified.content) {
      // Captions / document titles as naming context for later media from same sender
      text = extractCaption(classified.content);
    }
    if (!text) return;

    const chatId = key.remoteJid;
    const resolved = await resolveFolderSender(msg, sock, lidPhoneCache);
    const sender = textCacheSenderKey(
      resolved.folderSender,
      resolved.senderJid || pickPreferredSenderJid(msg),
    );
    const ts = messageTs(msg);
    const entry = { chatId, sender, ts, text, messageId: key.id };
    textWindow.push(entry);
    try {
      insertTextCache(db, entry);
    } catch (err) {
      logger.warn({ err: err.message }, 'text cache insert failed');
    }
  }

  async function handleIncomingMedia(msg) {
    const key = msg.key || {};
    if (key.fromMe) return; // incoming only
    if (!msg.message) return;

    const classified = classifyMessage(msg.message);
    await rememberText(msg);

    if (!shouldSaveMediaKind(classified.kind, config.mediaTypes)) {
      if (['audio', 'sticker', 'ptt'].includes(classified.kind)) {
        logger.debug({ kind: classified.kind, id: key.id }, 'skip media type');
      }
      return;
    }

    const msgKey = buildMsgKey(key);
    const existing = getProcessed(db, msgKey);
    if (existing?.status === 'saved') {
      logger.debug({ msgKey }, 'already saved — skip');
      return;
    }
    if (existing?.status === 'skipped') return;

    const chatId = key.remoteJid;
    const isGroup = jidIsGroup(chatId);
    const resolved = await resolveFolderSender(msg, sock, lidPhoneCache);
    const senderPhone = resolved.folderSender;
    const senderKey = textCacheSenderKey(
      senderPhone,
      resolved.senderJid || pickPreferredSenderJid(msg),
    );
    const ts = messageTs(msg);
    const originalFileName =
      classified.content?.fileName || classified.content?.filename || null;
    const caption = extractCaption(classified.content);
    const shortId = (key.id || 'unknown').slice(-8);

    const memTexts = textWindow.list(chatId);
    let dbTexts = [];
    try {
      dbTexts = listRecentTexts(db, {
        chatId,
        sender: senderKey,
        beforeTs: ts,
        limit: config.nearestTextMaxMessages * 2,
      });
    } catch {
      dbTexts = [];
    }
    const merged = [...dbTexts, ...memTexts];
    const fileLabel = resolveFileLabel({
      caption,
      chatId,
      sender: senderKey,
      mediaTs: ts,
      texts: merged,
      maxMessages: config.nearestTextMaxMessages,
      maxMinutes: config.nearestTextMaxMinutes,
      originalFileName,
    });

    const groupName = isGroup ? await refreshGroupName(chatId) : null;
    const dest = resolveDestination({
      saveRoot,
      isGroup,
      groupName,
      when: ts,
      senderPhone,
      fileLabel,
      shortMsgId: shortId,
      mimetype: classified.content?.mimetype,
      originalFileName,
      mediaType: classified.kind,
      timeZone: config.timezone,
    });

    upsertProcessed(db, {
      msg_key: msgKey,
      remote_jid: chatId,
      message_id: key.id,
      from_me: false,
      participant: key.participant || key.participantPn || null,
      sender: senderPhone,
      ts,
      media_type: classified.kind,
      folder_path: dest.relativeDir,
      file_path: dest.relativeFile,
      status: 'pending',
      error: null,
      retry_count: existing?.retry_count || 0,
    });

    await queue.enqueue(async () => {
      const tmpName = `${Date.now()}_${shortId}${dest.ext}`;
      const tmpPath = path.join(tmpDir, tmpName);
      try {
        await downloadToFile(sock, msg, tmpPath, logger);
        fs.mkdirSync(dest.absoluteFolder, { recursive: true });
        // Re-check collision at commit time
        let finalAbs = dest.absoluteFile;
        if (fs.existsSync(finalAbs)) {
          const stem = buildFileStem(fileLabel, shortId);
          const ext = extensionFromMeta({
            mimetype: classified.content?.mimetype,
            fileName: originalFileName,
            mediaType: classified.kind,
          });
          const name = nextAvailableFileName(stem, ext, (n) =>
            fs.existsSync(path.join(dest.absoluteFolder, n)),
          );
          finalAbs = path.join(dest.absoluteFolder, name);
        }
        fs.renameSync(tmpPath, finalAbs);
        const relativeFile = path.relative(saveRoot, finalAbs);
        upsertProcessed(db, {
          msg_key: msgKey,
          remote_jid: chatId,
          message_id: key.id,
          from_me: false,
          participant: key.participant || key.participantPn || null,
          sender: senderPhone,
          ts,
          media_type: classified.kind,
          folder_path: path.relative(saveRoot, path.dirname(finalAbs)),
          file_path: relativeFile,
          status: 'saved',
          error: null,
          retry_count: existing?.retry_count || 0,
        });
        logger.info(
          {
            file: relativeFile,
            type: classified.kind,
            sender: senderPhone,
            lid: resolved.lidJid || undefined,
          },
          'saved media',
        );
        setMeta(db, 'last_saved_ts', String(ts));
      } catch (err) {
        /* download / rename failure handled below */
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        const retries = (existing?.retry_count || 0) + 1;
        upsertProcessed(db, {
          msg_key: msgKey,
          remote_jid: chatId,
          message_id: key.id,
          from_me: false,
          participant: key.participant || key.participantPn || null,
          sender: senderPhone,
          ts,
          media_type: classified.kind,
          folder_path: dest.relativeDir,
          file_path: dest.relativeFile,
          status: 'failed',
          error: err?.message || String(err),
          retry_count: retries,
        });
        logger.error({ err: err?.message, msgKey, retries }, 'download failed');
      }
    });
  }

  function onMessagesUpsert(upsert) {
    const messages = upsert?.messages || [];
    for (const msg of messages) {
      handleIncomingMedia(msg).catch((err) => {
        logger.error({ err: err?.message }, 'handleIncomingMedia error');
      });
    }
  }

  /**
   * Best-effort catch-up: prune caches, touch meta cursor, flush note.
   * Full history scrape is intentionally limited to avoid bulk read marks.
   */
  async function catchUp() {
    if (catchingUp) {
      logger.info('catch-up already running — skip');
      return { skipped: true };
    }
    catchingUp = true;
    try {
      pruneTextCache(db);
      const pending = queue.pending;
      const active = queue.active;
      setMeta(db, 'last_catchup_ts', String(Math.floor(Date.now() / 1000)));
      const last = getMeta(db, 'last_saved_ts');
      logger.info({ pending, active, lastSavedTs: last }, 'catch-up / health sweep');
      touchHeartbeat(config.heartbeatPath, {
        mode: 'run',
        pending,
        active,
        lastSavedTs: last,
      });
      return { pending, active, lastSavedTs: last };
    } finally {
      catchingUp = false;
    }
  }

  function attach() {
    sock.ev.on('messages.upsert', onMessagesUpsert);
    // Cache group subjects when metadata events arrive
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates || []) {
        if (u.id && u.subject) groupNames.set(u.id, u.subject);
      }
    });
    // LID ↔ phone mappings (Baileys 6.7.22+)
    sock.ev.on('chats.phoneNumberShare', (ev) => {
      if (ev?.lid && ev?.jid) lidPhoneCache.remember(ev.lid, ev.jid);
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts || []) lidPhoneCache.rememberContact(c);
    });
    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts || []) lidPhoneCache.rememberContact(c);
    });
  }

  return {
    attach,
    catchUp,
    handleIncomingMedia,
    queue,
    lidPhoneCache,
  };
}
