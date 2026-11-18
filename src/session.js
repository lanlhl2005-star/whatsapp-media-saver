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
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

/** @param {object|undefined} lastDisconnect */
export function getDisconnectStatusCode(lastDisconnect) {
  const err = lastDisconnect?.error;
  if (err instanceof Boom) return err.output?.statusCode;
  return err?.output?.statusCode;
}

/** True unless WhatsApp invalidated the session (do not auto-reconnect). */
export function shouldReconnectAfterClose(statusCode) {
  return statusCode !== DisconnectReason.loggedOut;
}

/**
 * Render latest QR to terminal and optional PNG (always overwrite with fresh code).
 * @param {string} qr
 * @param {object} opts
 * @param {import('pino').Logger} opts.logger
 * @param {boolean} [opts.printQr=true]
 * @param {string} [opts.qrImagePath]
 */
export async function renderLinkQr(qr, { logger, printQr = true, qrImagePath } = {}) {
  if (printQr) {
    logger.info(
      'Fresh QR — open WhatsApp → Settings → Linked devices → Link a device and scan THIS code (ignore any earlier QR)',
    );
    qrcodeTerminal.generate(qr, { small: true });
  }
  if (qrImagePath) {
    try {
      fs.mkdirSync(path.dirname(qrImagePath), { recursive: true });
      await QRCode.toFile(qrImagePath, qr, {
        type: 'png',
        width: 480,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      logger.info(
        { qrImagePath },
        'QR also written as PNG — open that file on this PC if the terminal QR is hard to scan',
      );
    } catch (err) {
      logger.warn({ err: err.message, qrImagePath }, 'Could not write QR PNG');
    }
  }
}

/**
 * Create a Baileys linked-device socket.
 * @param {object} opts
 * @param {string} opts.authDir
 * @param {import('pino').Logger} opts.logger
 * @param {boolean} [opts.printQr=true]
 * @param {string} [opts.qrImagePath]  e.g. auth/qr.png
 * @param {(update: object) => void} [opts.onConnectionUpdate]
 */
export async function createSocket({
  authDir,
  logger,
  printQr = true,
  qrImagePath,
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
    if (qr) {
      // Always re-render the latest QR (WhatsApp rotates codes; 515 then new QR is normal).
      renderLinkQr(qr, { logger, printQr, qrImagePath }).catch((err) => {
        logger.warn({ err: err.message }, 'QR render failed');
      });
    }
    if (connection === 'open') {
      logger.info('WhatsApp linked-device session connected');
    }
    if (connection === 'close') {
      const statusCode = getDisconnectStatusCode(lastDisconnect);
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired =
        statusCode === DisconnectReason.restartRequired || statusCode === 515;
      if (restartRequired) {
        logger.info(
          { statusCode },
          'Connection closed with 515/restartRequired (normal during pairing) — will reconnect; wait for a fresh QR if shown',
        );
      } else {
        logger.warn({ statusCode, loggedOut }, 'Connection closed');
      }
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
