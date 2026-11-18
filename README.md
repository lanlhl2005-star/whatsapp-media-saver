# WhatsApp media saver (Windows MVP)

Local **linked-device** archive for WhatsApp. Uses [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) over a WebSocket — **no Chromium**, no phone-session takeover. Saves **incoming** images, videos, and documents under:

```text
F:\Scan\whatsapp media
```

Phone WhatsApp (and Desktop) stay usable as your primary session.

> **Cloud / CI note:** Do **not** scan a QR from this cloud agent. Copy the app to your always-on Windows PC and run `npm run link` there.

## Requirements

- **Windows** always-on PC (boot/logon Task Scheduler)
- **Node.js 20.9+** (`node -v`) — `@whiskeysockets/baileys@6.7.22` (security floor). A `postinstall` patch rewrites Baileys’ JSON import attributes so **Node 20.9** works (unpatched Baileys 6.7.19+ needs Node 20.10+)
- Disk path `F:\Scan\whatsapp media` (or override `SAVE_ROOT`)
- WhatsApp phone with spare **Linked devices** slot

## Install (on the Windows PC)

1. Copy this folder to the PC, e.g. `C:\Apps\whatsapp-media-saver\`.
2. Open **Command Prompt** or **PowerShell** in that folder:

```bat
node -v
npm install
```

3. Confirm save root (default already set in `config.json`):

```json
{
  "saveRoot": "F:\\Scan\\whatsapp media"
}
```

Override without editing the file:

```bat
set SAVE_ROOT=F:\Scan\whatsapp media
```

Or copy `config.example.json` → `config.local.json` and edit.

## Link once (QR or pairing code)

Do this on the **Windows PC**, not in the cloud.

### QR (default)

1. On the phone, open **WhatsApp → Settings → Linked devices → Link a device** *before* or as soon as the QR appears.
2. In the app folder:

```bat
npm run link
```

3. A QR prints in the terminal **and** is written to `auth\qr.png` (open that PNG if the terminal QR is hard to scan).
4. Scan the **latest** QR quickly. WhatsApp often closes with status **515** (restart required) during pairing — that is **normal**. The link process stays running, reconnects, and prints a **fresh** QR; scan the new one (ignore any earlier QR).
5. Wait up to **10 minutes** (heartbeat logs every 30s). Only exit on success, true `loggedOut`, or Ctrl+C.
6. Confirm the new device appears in Linked devices. Credentials persist under `auth\` — **do not commit or sync `auth\` to cloud shares.**

### Pairing code (if QR is awkward)

Use digits with country code, **no** `+` or spaces (E.164):

```bat
npm run link -- --phone 85291234567
```

Or:

```bat
set WMS_PHONE=85291234567
npm run link
```

Then on the phone: **Linked devices → Link with phone number** → enter the code printed in the console (and still wait through any 515 reconnect).

### When to delete `auth\`

- **Do not** delete `auth\` just because you saw 515 or a timeout mid-scan — clear only after a failed attempt if you want a clean slate, or when WhatsApp reports **`loggedOut`** / you unlinked the device.
- Re-link after logout: delete or quarantine `auth\`, then run `npm run link` again.

## Start the daemon

```bat
npm start
```

Leaves a long-lived process open. Incoming media is downloaded as it arrives. Every **10 minutes** the process also runs an internal catch-up/health sweep and refreshes `data\heartbeat.json`.

### CLI

| Command | npm script | Purpose |
| --- | --- | --- |
| `link` | `npm run link` | QR / pairing-code link (10 min wait; reconnects on 515) |
| `run` | `npm start` | Persistent saver daemon |
| `health` | `npm run health` | Exit `0` if heartbeat fresh; else `1` |
| `catchup` | `npm run catchup` | Report cursor + daemon heartbeat |

```bat
node src\index.js help
npm run link -- --phone 85291234567
```

## Always-on: Task Scheduler

### Quick register (PowerShell)

From the app folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\register-tasks.ps1
Start-ScheduledTask -TaskName WhatsAppMediaSaver-Daemon
```

This creates:

1. **WhatsAppMediaSaver-Daemon** — **At log on**, restart on failure → runs `scripts\run-daemon.cmd`
2. **WhatsAppMediaSaver-Health** — every **10 minutes** → runs `scripts\healthcheck.cmd` (`node src\index.js health`)

Keep a user session available on the always-on machine (interactive logon task). For a true Windows Service wrapper later, NSSM/WinSW is a nicety — not required for MVP.

### Manual Task Scheduler UI

1. **Task Scheduler → Create Task…**
2. **Daemon**
   - Trigger: **At log on** (your user)
   - Action: `cmd.exe /c "C:\Apps\whatsapp-media-saver\scripts\run-daemon.cmd"`
   - Settings: restart on failure; allow on battery; **no** execution time limit
3. **Health**
   - Trigger: repeat every **10 minutes** indefinitely
   - Action: `cmd.exe /c "C:\Apps\whatsapp-media-saver\scripts\healthcheck.cmd"`

## What gets saved

| Saved | Skipped |
| --- | --- |
| Incoming **image**, **video**, **document** | Audio, stickers, voice notes / PTT |
| | Outgoing (`fromMe`) media |

### Layout

**1:1 chat**

```text
F:\Scan\whatsapp media\
  2026-11-17_14-03-22_+85291234567\
    invoice-october.pdf
```

**Group chat** (covering folder = group subject)

```text
F:\Scan\whatsapp media\
  Project-Alpha\
    2026-11-17_14-05-01_+85291234567\
      family-dinner.jpg
```

- Folder timestamp = message send time in **GMT+0800** (`Asia/Hong_Kong`), not PC local TZ.
- File name = **caption**, else nearest same-sender text within **15 messages or 30 minutes**; sanitized; original extension kept; collisions → `name__2.ext`.

## State & secrets

| Path | Purpose |
| --- | --- |
| `auth\` | Baileys multi-file credentials (**secret**) |
| `data\state.sqlite` | Dedupe by message key; text cache; cursors |
| `data\heartbeat.json` | Daemon liveness for `health` |
| `config.json` / `config.local.json` | Paths & knobs (no WhatsApp passwords) |

`.gitignore` excludes `auth\`, SQLite, heartbeat, and `node_modules\`.

## Safety (MVP)

- Linked-device only — does **not** replace the phone session.
- Does **not** send messages, bulk-mark chats read, or scrape contacts beyond saving media.
- Rate-limits concurrent downloads (default 2).
- On `loggedOut`, stops reconnect storms and asks you to re-link.
- Unofficial clients carry ToS / ban risk — personal archival, low volume.

## Develop / test

```bat
npm test
```

Unit tests cover sanitize/naming, nearest-text, and media-type classification (no live WhatsApp).

### Project layout

```text
whatsapp-media-saver/
  src/
    index.js          # CLI entry (link | run | health | catchup)
    config.js
    session.js        # Baileys socket + download
    pipeline.js       # ingest → name → save → SQLite
    naming.js
    nearest-text.js
    media-types.js
    db.js
    ...
  scripts/
    run-daemon.cmd
    healthcheck.cmd
    register-tasks.ps1
  test/
  config.json
  README.md
```

## Verify on your PC

1. `npm run link` → open Linked devices, scan the **latest** QR (or use `--phone`); if 515 appears, wait for the new QR.
2. `npm start`.
3. From another account (or a contact), send an image with a caption.
4. Confirm `F:\Scan\whatsapp media\<timestamp_+phone>\<caption>.jpg` appears.
5. Restart `npm start` — same message must **not** duplicate (SQLite dedupe).

## Copy checklist

1. Zip/copy `whatsapp-media-saver\` to the Windows PC (without `node_modules\` / `auth\` if any).
2. `npm install`
3. Ensure `F:\Scan\whatsapp media` exists (or set `SAVE_ROOT`).
4. `npm run link` → scan latest QR (or `npm run link -- --phone 852…`).
5. `npm start` or register Task Scheduler via `scripts\register-tasks.ps1`.

### Windows retry (if an older build timed out after 515)

```bat
cd C:\Apps\whatsapp-media-saver
rmdir /s /q auth
npm install
npm run link
```

Scan within seconds of each **NEW** QR. Optional pairing code:

```bat
npm run link -- --phone 85291234567
```
