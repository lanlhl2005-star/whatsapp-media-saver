import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

/**
 * Create a Baileys linked-device socket.
 * @param {object} opts
 * @param {string} opts.authDir
 * @param {import('pino').Logger} opts.logger
 * @param {boolean} [opts.printQr=true]
 * @param {(update: object) => void} [opts.onConnectionUpdate]
 */
export async function createSocket({
  authDir,
  logger,
  printQr = true,
  onConnectionUpdate,
}) {
  fs.mkdirSync(authDir, { recursive: true });
  try {
    fs.chmodSync(authDir, 0o700);
  } catch {
    // Windows may ignore chmod — fine
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not fetch latest Baileys version; using built-in');
  }

  const sockLogger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, sockLogger),
    },
    logger: sockLogger,
    browser: Browsers.appropriate('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && printQr) {
      logger.info('Scan this QR in WhatsApp → Settings → Linked devices → Link a device');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      logger.info('WhatsApp linked-device session connected');
    }
    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, loggedOut }, 'Connection closed');
    }
    onConnectionUpdate?.(update);
  });

  return { sock, saveCreds };
}

/**
 * Stream a media message to destPath (atomic via .part then rename).
 */
export async function downloadToFile(sock, waMessage, destPath, logger) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const partPath = `${destPath}.part`;
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch {
    /* ignore */
  }

  const stream = await downloadMediaMessage(
    waMessage,
    'stream',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage.bind(sock),
    },
  );

  await streamPipeline(stream, createWriteStream(partPath));
  fs.renameSync(partPath, destPath);
  return destPath;
}

export { DisconnectReason };
