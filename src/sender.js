/**
 * Resolve message sender to a folder segment.
 * Prefer real phone JIDs (@s.whatsapp.net / senderPn / participantPn).
 * Never format a raw LID as +digits.
 */

import {
  folderSenderSegment,
  isLidJid,
  isPhoneJid,
  jidUserPart,
} from './naming.js';

export function jidIsGroup(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * In-memory LID ↔ phone map fed by contacts / phoneNumberShare / resolved lookups.
 */
export function createLidPhoneCache() {
  /** @type {Map<string, string>} lidUser -> phoneUser (digits) */
  const lidToPn = new Map();
  /** @type {Map<string, string>} phoneUser -> lidUser */
  const pnToLid = new Map();

  function remember(lidJid, phoneJid) {
    if (!lidJid || !phoneJid) return;
    const lidUser = jidUserPart(lidJid);
    const pnUser = jidUserPart(phoneJid);
    if (!lidUser || !pnUser) return;
    if (!/^\d{6,20}$/.test(pnUser)) return;
    // Accept lid as full @lid JID or bare numeric lid user
    const lidOk =
      isLidJid(lidJid) ||
      String(lidJid).toLowerCase().includes('@lid') ||
      /^\d{6,20}$/.test(lidUser);
    if (!lidOk) return;
    const phoneOk =
      isPhoneJid(phoneJid) || /^\+?\d{6,15}$/.test(String(phoneJid).trim());
    if (!phoneOk) return;
    lidToPn.set(lidUser, pnUser);
    pnToLid.set(pnUser, lidUser);
  }

  function rememberContact(contact) {
    if (!contact || typeof contact !== 'object') return;
    const phone =
      (isPhoneJid(contact.jid) && contact.jid) ||
      (isPhoneJid(contact.id) && contact.id) ||
      null;
    const lid =
      (isLidJid(contact.lid) && contact.lid) ||
      (isLidJid(contact.id) && contact.id) ||
      null;
    if (phone && lid) remember(lid, phone);
  }

  function phoneJidForLid(lidJid) {
    const lidUser = jidUserPart(lidJid);
    if (!lidUser) return null;
    const pnUser = lidToPn.get(lidUser);
    return pnUser ? `${pnUser}@s.whatsapp.net` : null;
  }

  return {
    remember,
    rememberContact,
    phoneJidForLid,
    /** @returns {{ lidToPn: Map<string,string>, pnToLid: Map<string,string> }} */
    snapshot() {
      return { lidToPn, pnToLid };
    },
  };
}

/**
 * Raw sender JID candidates from a Baileys message, phone-first order.
 * @param {object} msg
 * @returns {string[]}
 */
export function senderJidCandidates(msg) {
  const key = msg?.key || {};
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  };

  // Baileys 6.7.22 populates explicit phone mirrors when available
  push(key.participantPn);
  push(key.senderPn);

  if (jidIsGroup(key.remoteJid)) {
    push(key.participant);
    push(msg?.participant);
    push(key.participantLid);
  } else {
    // 1:1 — remoteJid may be @lid; prefer PN mirrors already pushed
    push(key.remoteJid);
    push(key.senderLid);
  }

  return out;
}

/**
 * Best raw sender identifier for text-cache keys before async resolve.
 * Prefers phone JIDs over LIDs among candidates.
 */
export function pickPreferredSenderJid(msg) {
  const candidates = senderJidCandidates(msg);
  const phone = candidates.find((j) => isPhoneJid(j));
  if (phone) return phone;
  return candidates[0] || null;
}

/**
 * Try Baileys sock helpers to map LID → phone JID.
 * Works with 6.7.22 contacts / future signalRepository.lidMapping.
 * @param {string} lidJid
 * @param {object|null|undefined} sock
 * @param {ReturnType<typeof createLidPhoneCache>} cache
 */
export async function resolveLidToPhoneJid(lidJid, sock, cache) {
  if (!isLidJid(lidJid)) return null;

  const cached = cache?.phoneJidForLid?.(lidJid);
  if (cached) return cached;

  // Newer Baileys (post-6.7.22) may expose lidMapping on the signal repo
  const mapping = sock?.signalRepository?.lidMapping;
  if (mapping && typeof mapping.getPNForLID === 'function') {
    try {
      const pn = await mapping.getPNForLID(lidJid);
      if (pn && isPhoneJid(pn)) {
        cache?.remember?.(lidJid, pn);
        return pn;
      }
    } catch {
      /* ignore — fall through */
    }
  }

  // Contact store if present (optional makeInMemoryStore / custom)
  const contacts = sock?.store?.contacts || sock?.contacts;
  if (contacts && typeof contacts === 'object') {
    const lidUser = jidUserPart(lidJid);
    for (const c of Object.values(contacts)) {
      if (!c) continue;
      const cLid = jidUserPart(c.lid || (isLidJid(c.id) ? c.id : null));
      if (cLid && lidUser && cLid === lidUser) {
        const phone =
          (isPhoneJid(c.jid) && c.jid) || (isPhoneJid(c.id) && c.id) || null;
        if (phone) {
          cache?.remember?.(lidJid, phone);
          return phone;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve folder sender segment (+E164 | lid_<id> | unknown) for a message.
 * @returns {Promise<{ senderJid: string|null, folderSender: string, phoneJid: string|null, lidJid: string|null }>}
 */
export async function resolveFolderSender(msg, sock, cache) {
  const candidates = senderJidCandidates(msg);
  let lidJid = candidates.find((j) => isLidJid(j)) || null;
  let phoneJid = candidates.find((j) => isPhoneJid(j)) || null;

  if (!phoneJid && lidJid) {
    phoneJid = await resolveLidToPhoneJid(lidJid, sock, cache);
  }

  // Also try cache against any candidate that looks like a lid user without domain
  if (!phoneJid) {
    for (const c of candidates) {
      if (isLidJid(c)) {
        phoneJid = await resolveLidToPhoneJid(c, sock, cache);
        if (phoneJid) {
          lidJid = c;
          break;
        }
      }
    }
  }

  const senderJid = phoneJid || lidJid || candidates[0] || null;
  const folderSender = folderSenderSegment(senderJid);
  return { senderJid, folderSender, phoneJid, lidJid };
}

/**
 * Stable text-cache sender key: prefer phone folder segment, else lid_/unknown.
 * Matching uses this so LID vs PN of the same person still collide after resolve.
 */
export function textCacheSenderKey(folderSender, rawJid) {
  if (folderSender && folderSender !== 'unknown') return folderSender;
  if (rawJid) return folderSenderSegment(rawJid);
  return 'unknown';
}
