#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { openDb, getMeta } from './db.js';
import { ensureSaveRoot } from './paths.js';
import { createSocket, DisconnectReason } from './session.js';
import { createPipeline } from './pipeline.js';
import { checkHeartbeat, touchHeartbeat } from './heartbeat.js';
import { Boom } from '@hapi/boom';

const COMMANDS = ['link', 'run', 'health', 'catchup', 'help'];

function printHelp() {
  console.log(`WhatsApp media saver — local linked-device archive

Usage:
  node src/index.js <command>
  npm run link | start | health | catchup

Commands:
  link      Pair once via QR (WhatsApp → Linked devices). Persist auth/ and exit when connected.
  run       Long-lived daemon: receive incoming image/video/document and save under SAVE_ROOT.
  health    Exit 0 if daemon heartbeat is fresh; else exit 1 (for Task Scheduler).
  catchup   One-shot catch-up/health sweep against a running daemon's DB (or start brief sweep).
  help      Show this help.

Config:
  config.json / config.local.json / env SAVE_ROOT
  Default SAVE_ROOT: F:\\Scan\\whatsapp media

Safety:
  Linked-device only. Does not send messages or bulk-mark chats read.
  Run "link" on your Windows PC (not on a cloud VM).
`);
}

async function waitUntilConnected(sock, { timeoutMs = 180_000, requireOpen = true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WhatsApp connection / QR scan'));
    }, timeoutMs);

    function onUpdate(update) {
      if (update.connection === 'open') {
        cleanup();
        resolve({ connected: true });
      }
      if (update.connection === 'close') {
        const code =
          update.lastDisconnect?.error instanceof Boom
            ? update.lastDisconnect.error.output?.statusCode
            : update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          cleanup();
          reject(new Error('Logged out — delete auth/ and run link again'));
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      sock.ev.off('connection.update', onUpdate);
    }

    sock.ev.on('connection.update', onUpdate);
    if (!requireOpen) {
      // no-op
    }
  });
}

async function cmdLink(config) {
  logger.info({ authDir: config.authDir }, 'Starting link (QR) flow');
  let shouldExit = false;

  const { sock } = await createSocket({
    authDir: config.authDir,
    logger,
    printQr: true,
    onConnectionUpdate: (update) => {
      if (update.connection === 'open') {
        shouldExit = true;
      }
      if (update.connection === 'close') {
        const code =
          update.lastDisconnect?.error instanceof Boom
            ? update.lastDisconnect.error.output?.statusCode
            : update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error('Logged out during link. Remove auth/ and retry.');
          process.exitCode = 1;
          shouldExit = true;
        }
      }
    },
  });

  await waitUntilConnected(sock);
  logger.info(
    'Linked successfully. Credentials saved under auth/. You can close this and run: npm start',
  );
  try {
    sock.end?.(undefined);
  } catch {
    /* ignore */
  }
  // Give creds a moment to flush
  await new Promise((r) => setTimeout(r, 500));
  if (shouldExit) process.exit(0);
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
      onConnectionUpdate: async (update) => {
        if (update.connection === 'close') {
          const code =
            update.lastDisconnect?.error instanceof Boom
              ? update.lastDisconnect.error.output?.statusCode
              : update.lastDisconnect?.error?.output?.statusCode;
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
            const delay = 5_000;
            logger.warn({ delay }, 'Reconnecting…');
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

  if (cmd === 'link') return cmdLink(config);
  if (cmd === 'run') return cmdRun(config);
  if (cmd === 'health') return cmdHealth(config);
  if (cmd === 'catchup') return cmdCatchup(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
