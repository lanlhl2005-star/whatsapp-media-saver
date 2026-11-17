import fs from 'node:fs';
import path from 'node:path';

export function touchHeartbeat(heartbeatPath, extra = {}) {
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  const payload = {
    pid: process.pid,
    ts: Date.now(),
    iso: new Date().toISOString(),
    ...extra,
  };
  const tmp = `${heartbeatPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, heartbeatPath);
  return payload;
}

export function readHeartbeat(heartbeatPath) {
  try {
    if (!fs.existsSync(heartbeatPath)) return null;
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {{ ok: boolean, reason: string, heartbeat: object|null }}
 */
export function checkHeartbeat(heartbeatPath, staleMs = 120_000) {
  const hb = readHeartbeat(heartbeatPath);
  if (!hb || !hb.ts) {
    return { ok: false, reason: 'missing_heartbeat', heartbeat: hb };
  }
  const age = Date.now() - Number(hb.ts);
  if (!Number.isFinite(age) || age > staleMs) {
    return { ok: false, reason: 'stale_heartbeat', heartbeat: hb, ageMs: age };
  }
  // Optional: verify pid still alive (best-effort; Windows/Linux)
  if (hb.pid) {
    try {
      process.kill(hb.pid, 0);
    } catch {
      return { ok: false, reason: 'process_dead', heartbeat: hb };
    }
  }
  return { ok: true, reason: 'ok', heartbeat: hb, ageMs: age };
}
