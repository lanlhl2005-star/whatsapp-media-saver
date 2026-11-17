/**
 * Classify Baileys message content into MVP media kinds.
 * MVP saves: image, video, document. Skips: audio, sticker, PTT/voice.
 */

const SAVE_KINDS = new Set(['image', 'video', 'document']);

/**
 * Unwrap ephemeral / view-once wrappers to the inner message object.
 * @param {object|null|undefined} message
 */
export function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

/**
 * @returns {{ kind: 'image'|'video'|'document'|'audio'|'sticker'|'ptt'|'text'|'other'|'none', content: object|null, contentType: string|null }}
 */
export function classifyMessage(message) {
  const inner = unwrapMessage(message);
  if (!inner) return { kind: 'none', content: null, contentType: null };

  if (inner.imageMessage) {
    return { kind: 'image', content: inner.imageMessage, contentType: 'imageMessage' };
  }
  if (inner.videoMessage) {
    // GIFs often arrive as videoMessage with gifPlayback — treat as video (saved)
    return { kind: 'video', content: inner.videoMessage, contentType: 'videoMessage' };
  }
  if (inner.documentMessage) {
    return { kind: 'document', content: inner.documentMessage, contentType: 'documentMessage' };
  }
  if (inner.audioMessage) {
    const ptt = Boolean(inner.audioMessage.ptt);
    return {
      kind: ptt ? 'ptt' : 'audio',
      content: inner.audioMessage,
      contentType: 'audioMessage',
    };
  }
  if (inner.stickerMessage) {
    return { kind: 'sticker', content: inner.stickerMessage, contentType: 'stickerMessage' };
  }
  if (inner.conversation || inner.extendedTextMessage) {
    return { kind: 'text', content: inner, contentType: 'text' };
  }
  return { kind: 'other', content: inner, contentType: null };
}

export function shouldSaveMediaKind(kind, allowed = ['image', 'video', 'document']) {
  const allow = new Set(allowed?.length ? allowed : [...SAVE_KINDS]);
  return allow.has(kind);
}
