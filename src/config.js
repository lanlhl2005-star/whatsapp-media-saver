import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  saveRoot: 'F:\\Scan\\whatsapp media',
  authDir: 'auth',
  stateDb: 'data/state.sqlite',
  timezone: 'Asia/Hong_Kong',
  // Filename nearest-text (locked plan §7 Q8)
  nearestTextMaxMessages: 15,
  nearestTextMaxMinutes: 30,
  // description.txt / meta.json surrounding texts (per side: before & after)
  contextMaxMessages: 5,
  contextMaxMinutes: 15,
  maxConcurrentDownloads: 2,
  heartbeatPath: 'data/heartbeat.json',
  heartbeatStaleMs: 120_000,
  downloadRetryLimit: 5,
  mediaTypes: ['image', 'video', 'document'],
};

function resolveMaybeRelative(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p);
}

function loadJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read config ${filePath}: ${err.message}`);
  }
}

/**
 * Load config with overrides:
 * 1) config.json defaults
 * 2) config.local.json (optional)
 * 3) SAVE_ROOT / WMS_* env vars
 */
export function loadConfig(overrides = {}) {
  const fileCfg =
    loadJsonIfExists(path.join(APP_ROOT, 'config.local.json')) ||
    loadJsonIfExists(path.join(APP_ROOT, 'config.json')) ||
    {};

  const env = {};
  if (process.env.SAVE_ROOT) env.saveRoot = process.env.SAVE_ROOT;
  if (process.env.WMS_AUTH_DIR) env.authDir = process.env.WMS_AUTH_DIR;
  if (process.env.WMS_STATE_DB) env.stateDb = process.env.WMS_STATE_DB;
  if (process.env.WMS_HEARTBEAT) env.heartbeatPath = process.env.WMS_HEARTBEAT;

  const merged = { ...DEFAULTS, ...fileCfg, ...env, ...overrides };

  const authDir = resolveMaybeRelative(merged.authDir);
  const stateDb = resolveMaybeRelative(merged.stateDb);
  const heartbeatPath = resolveMaybeRelative(merged.heartbeatPath);
  const saveRoot = merged.saveRoot; // keep Windows absolute path as-is

  return {
    ...merged,
    authDir,
    stateDb,
    heartbeatPath,
    saveRoot,
    appRoot: APP_ROOT,
  };
}
