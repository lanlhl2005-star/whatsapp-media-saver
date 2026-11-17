# WhatsApp media saver (Windows MVP)

Local **linked-device** archive for WhatsApp. Uses [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) over a WebSocket — **no Chromium**, no phone-session takeover. Saves **incoming** images, videos, and documents under:

```text
F:\Scan\whatsapp media
```

Phone WhatsApp (and Desktop) stay usable as your primary session.

> **Cloud / CI note:** Do **not** scan a QR from this cloud agent. Copy the app to your always-on Windows PC and run `npm run link` there.

## Requirements

- **Windows** always-on PC (boot/logon Task Scheduler)
- **Node.js 20+** (`node -v`)
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

## Link once (QR)

```bat
npm run link
```

1. A QR appears in the terminal.
2. On the phone: **WhatsApp → Settings → Linked devices → Link a device** → scan.
3. Confirm the new device appears in the linked list.
4. Credentials persist under `auth\` — **do not commit or sync `auth\` to cloud shares.**

Re-link only if you unlink the device or WhatsApp invalidates the session (`loggedOut`). Delete/quarantine `auth\` then run `npm run link` again.

## Start the daemon

```bat
npm start
```

Leaves a long-lived process open. Incoming media is downloaded as it arrives. Every **10 minutes** the process also runs an internal catch-up/health sweep and refreshes `data\heartbeat.json`.

### CLI

| Command | npm script | Purpose |
| --- | --- | --- |
| `link` | `npm run link` | QR pairing |
| `run` | `npm start` | Persistent saver daemon |
| `health` | `npm run health` | Exit `0` if heartbeat fresh; else `1` |
| `catchup` | `npm run catchup` | Report cursor + daemon heartbeat |

```bat
node src\index.js help
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

1. `npm run link` → scan QR.
2. `npm start`.
3. From another account (or a contact), send an image with a caption.
4. Confirm `F:\Scan\whatsapp media\<timestamp_+phone>\<caption>.jpg` appears.
5. Restart `npm start` — same message must **not** duplicate (SQLite dedupe).

## Copy checklist

1. Zip/copy `whatsapp-media-saver\` to the Windows PC (without `node_modules\` / `auth\` if any).
2. `npm install`
3. Ensure `F:\Scan\whatsapp media` exists (or set `SAVE_ROOT`).
4. `npm run link` → scan on phone.
5. `npm start` or register Task Scheduler via `scripts\register-tasks.ps1`.
