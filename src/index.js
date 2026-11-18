#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { openDb, getMeta } from './db.js';
import { ensureSaveRoot } from './paths.js';
import {
  createSocket,
  DisconnectReason,
  getDisconnectStatusCode,
  shouldReconnectAfterClose,
} from './session.js';
import { createPipeline } from './pipeline.js';
import { checkHeartbeat, touchHeartbeat } from './heartbeat.js';
import { DEFAULT_LINK_TIMEOUT_MS, parseLinkArgs } from './link-args.js';

const COMMANDS = ['link', 'run', 'health', 'catchup', 'help'];
const LINK_HEARTBEAT_MS = 30_000;

function printHelp() {
  console.log(`WhatsApp media saver — local linked-device archive

Usage:
  node src/index.js <command> [options]
  npm run link | start | health | catchup

Commands:
  link      Pair once (QR and/or pairing code). Persist auth/ and exit when connected.
  run       Long-lived daemon: receive incoming image/video/document and save under SAVE_ROOT.
  health    Exit 0 if daemon heartbeat is fresh; else exit 1 (for Task Scheduler).
  catchup   One-shot catch-up/health sweep against a running daemon's DB (or start brief sweep).
  help      Show this help.

Link options:
  --phone <E.164 digits>   Pairing code instead of (or in addition to) QR
                           e.g. npm run link -- --phone 85291234567
  --timeout-ms <n>         Max wait for first open (default ${DEFAULT_LINK_TIMEOUT_MS})

Env:
  WMS_PHONE / WHATSAPP_PHONE   Same as --phone
  WMS_LINK_TIMEOUT_MS          Same as --timeout-ms
  config.json / config.local.json / env SAVE_ROOT
  Default SAVE_ROOT: F:\\Scan\\whatsapp media

Safety:
  Linked-device only. Does not send messages or bulk-mark chats read.
  Run "link" on your Windows PC (not on a cloud VM).
  Status 515 during pairing is normal — wait for a fresh QR; do not delete auth/ unless loggedOut.
`);
}

async function cmdLink(config, linkOpts = {}) {
  const { phone = null, timeoutMs = DEFAULT_LINK_TIMEOUT_MS } = linkOpts;
  const qrImagePath = path.join(config.authDir, 'qr.png');

  logger.info(
    {
      authDir: config.authDir,
      qrImagePath,
      pairingPhone: phone || undefined,
      timeoutMs,
    },
    phone
      ? 'Starting link (pairing-code) flow'
      : 'Starting link (QR) flow',
  );
  if (!phone) {
    logger.info(
      'Tip: open Linked devices on the phone first, then scan quickly when a NEW QR appears. If you see 515, wait — a fresh QR will print. Or use: npm run link -- --phone 852xxxxxxxx',
    );
  } else {
    logger.info(
      { phone },
      'Will request a pairing code after WhatsApp connects (Linked devices → Link with phone number)',
    );
  }

  let sockRef = null;
  let reconnecting = false;
  let settled = false;
  let pairingRequestedForSock = false;

  const shutdownSock = () => {
    try {
      sockRef?.end?.(undefined);
    } catch {
      /* ignore */
    }
  };

  const onSigint = () => {
    if (settled) return;
    settled = true;
    logger.info('Link cancelled (Ctrl+C). Auth left as-is — rerun link when ready.');
    shutdownSock();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();

      const heartbeat = setInterval(() => {
        if (settled) return;
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const remainSec = Math.max(
          0,
          Math.round((timeoutMs - (Date.now() - startedAt)) / 1000),
        );
        logger.info(
          { elapsedSec, remainSec, qrImagePath },
          'Still waiting for WhatsApp link — scan the latest QR (or enter pairing code); 515 reconnects are normal',
        );
      }, LINK_HEARTBEAT_MS);

      const timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for WhatsApp connection / QR scan`,
          ),
        );
      }, timeoutMs);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        fn(value);
      }

      const connect = async () => {
        pairingRequestedForSock = false;
        const { sock } = await createSocket({
          authDir: config.authDir,
          logger,
          printQr: true,
          qrImagePath,
          onConnectionUpdate: (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Pairing code: request once per socket after QR/connecting (Baileys requirement).
            if (
              phone &&
              !pairingRequestedForSock &&
              !sock.authState?.creds?.registered &&
              (qr || connection === 'connecting')
            ) {
              pairingRequestedForSock = true;
              sock
                .requestPairingCode(phone)
                .then((code) => {
                  const formatted = String(code).replace(/(.{4})/g, '$1-').replace(/-$/, '');
                  logger.info(
                    { code, formatted },
                    'Enter this pairing code on the phone: WhatsApp → Linked devices → Link with phone number',
                  );
                  console.log(`\n  Pairing code: ${formatted}\n`);
                })
                .catch((err) => {
                  pairingRequestedForSock = false;
                  logger.error({ err: err.message }, 'requestPairingCode failed — will retry on next QR');
                });
            }

            if (connection === 'open') {
              finish(resolve, { connected: true });
              return;
            }

            if (connection === 'close') {
              const statusCode = getDisconnectStatusCode(lastDisconnect);
              if (!shouldReconnectAfterClose(statusCode)) {
                logger.error(
                  'Logged out during link. Delete/quarantine auth/ then run link again.',
                );
                finish(
                  reject,
                  new Error('Logged out — delete auth/ and run link again'),
                );
                return;
              }

              const restartRequired =
                statusCode === DisconnectReason.restartRequired || statusCode === 515;
              // 515 must reconnect immediately with saved creds; other closes can wait briefly.
              const delay = restartRequired ? 0 : 1_500;
              if (reconnecting || settled) return;
              reconnecting = true;
              logger.info(
                { statusCode, delay },
                restartRequired
                  ? '515 restart required — reconnecting now (expect a fresh QR if still unpaired)'
                  : 'Transient disconnect during link — reconnecting…',
              );
              setTimeout(() => {
                reconnecting = false;
                if (settled) return;
                connect().catch((err) => finish(reject, err));
              }, delay);
            }
          },
        });
        sockRef = sock;
      };

      connect().catch((err) => finish(reject, err));
    });

    logger.info(
      'Linked successfully. Credentials saved under auth/. You can close this and run: npm start',
    );
    try {
      fs.unlinkSync(qrImagePath);
    } catch {
      /* optional cleanup */
    }
    shutdownSock();
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
  }
}

async function cmdRun(config) {
  const authCreds = path.join(config.authDir, 'creds.json');
  if (!fs.existsSync(authCreds)) {
    logger.error('No auth/creds.json — run `npm run link` on this Windows PC first.');
    process.exit(1);
  }

  const db = openDb(config.stateDb);
  const { saveRoot, tmpDir, usingFallback } = ensureSaveRoot(config, logger);
  if (usingFallback) {
    logger.warn({ saveRoot }, 'Using fallback SAVE_ROOT (not F:\\…). Override with SAVE_ROOT or config.');
  } else {
    logger.info({ saveRoot }, 'SAVE_ROOT ready');
  }

  let restarting = false;
  let heartbeatTimer;
  let catchupTimer;
  let sockRef;

  const start = async () => {
    const { sock } = await createSocket({
      authDir: config.authDir,
      logger,
      printQr: true,
      qrImagePath: path.join(config.authDir, 'qr.png'),
      onConnectionUpdate: async (update) => {
        if (update.connection === 'close') {
          const code = getDisconnectStatusCode(update.lastDisconnect);
          const loggedOut = code === DisconnectReason.loggedOut;
          if (loggedOut) {
            logger.error(
              'Session logged out. Stopped auto-reconnect. Delete or quarantine auth/ then run link again.',
            );
            clearInterval(heartbeatTimer);
            clearInterval(catchupTimer);
            process.exitCode = 2;
            return;
          }
          if (!restarting) {
            restarting = true;
            const restartRequired =
              code === DisconnectReason.restartRequired || code === 515;
            const delay = restartRequired ? 0 : 5_000;
            logger.warn(
              { delay, statusCode: code },
              restartRequired
                ? '515 restart required — reconnecting immediately…'
                : 'Reconnecting…',
            );
            setTimeout(() => {
              restarting = false;
              start().catch((err) => {
                logger.error({ err: err.message }, 'reconnect failed');
                process.exit(1);
              });
            }, delay);
          }
        }
        if (update.connection === 'open') {
          touchHeartbeat(config.heartbeatPath, { mode: 'run', connection: 'open' });
        }
      },
    });
    sockRef = sock;

    const pipeline = createPipeline({
      config,
      db,
      sock,
      logger,
      saveRoot,
      tmpDir,
    });
    pipeline.attach();

    clearInterval(heartbeatTimer);
    clearInterval(catchupTimer);
    heartbeatTimer = setInterval(() => {
      touchHeartbeat(config.heartbeatPath, {
        mode: 'run',
        queue: pipeline.queue.size,
      });
    }, 30_000);
    catchupTimer = setInterval(() => {
      pipeline.catchUp().catch((err) => logger.warn({ err: err.message }, 'catch-up error'));
    }, 10 * 60 * 1000);

    touchHeartbeat(config.heartbeatPath, { mode: 'run', connection: 'starting' });
    logger.info('Daemon running — incoming image/video/document will be saved. Ctrl+C to stop.');
  };

  const shutdown = () => {
    logger.info('Shutting down…');
    clearInterval(heartbeatTimer);
    clearInterval(catchupTimer);
    try {
      sockRef?.end?.(undefined);
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await start();
}

function cmdHealth(config) {
  const result = checkHeartbeat(config.heartbeatPath, config.heartbeatStaleMs);
  if (result.ok) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          ageMs: result.ageMs,
          pid: result.heartbeat?.pid,
          iso: result.heartbeat?.iso,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: result.reason,
        ageMs: result.ageMs,
        heartbeat: result.heartbeat,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

async function cmdCatchup(config) {
  // Lightweight: report DB cursor + heartbeat; if daemon is up this is enough.
  // Full reconnect catch-up is owned by the running daemon's 10-min timer.
  const result = checkHeartbeat(config.heartbeatPath, config.heartbeatStaleMs);
  let lastSaved = null;
  let lastCatchup = null;
  try {
    if (fs.existsSync(config.stateDb)) {
      const db = openDb(config.stateDb);
      lastSaved = getMeta(db, 'last_saved_ts');
      lastCatchup = getMeta(db, 'last_catchup_ts');
      db.close();
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'could not open state db');
  }

  const payload = {
    daemonOk: result.ok,
    reason: result.reason,
    lastSavedTs: lastSaved,
    lastCatchupTs: lastCatchup,
    note: result.ok
      ? 'Daemon heartbeat is fresh; in-process catch-up runs every 10 minutes inside `run`.'
      : 'Daemon heartbeat missing/stale — start `npm start` (Task Scheduler At log on).',
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(result.ok ? 0 : 1);
}

async function main() {
  const cmd = (process.argv[2] || 'help').toLowerCase();
  if (!COMMANDS.includes(cmd) || cmd === 'help') {
    printHelp();
    process.exit(cmd === 'help' || !process.argv[2] ? 0 : 1);
  }

  const config = loadConfig();
  const rest = process.argv.slice(3);

  if (cmd === 'link') return cmdLink(config, parseLinkArgs(rest));
  if (cmd === 'run') return cmdRun(config);
  if (cmd === 'health') return cmdHealth(config);
  if (cmd === 'catchup') return cmdCatchup(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
