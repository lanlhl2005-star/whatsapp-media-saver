/** Default link wait: 10 minutes (slow scanners / 515 + fresh QR). */
export const DEFAULT_LINK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {string[]} argv  args after the `link` command
 */
export function parseLinkArgs(argv = []) {
  let phone = process.env.WMS_PHONE || process.env.WHATSAPP_PHONE || null;
  let timeoutMs = Number(process.env.WMS_LINK_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    timeoutMs = DEFAULT_LINK_TIMEOUT_MS;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phone' || a === '-p') {
      phone = argv[++i] ?? phone;
    } else if (a.startsWith('--phone=')) {
      phone = a.slice('--phone='.length);
    } else if (a === '--timeout-ms') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) timeoutMs = n;
    } else if (a.startsWith('--timeout-ms=')) {
      const n = Number(a.slice('--timeout-ms='.length));
      if (Number.isFinite(n) && n > 0) timeoutMs = n;
    }
  }

  if (phone) {
    phone = String(phone).replace(/\D/g, '');
    if (!phone) phone = null;
  }

  return { phone, timeoutMs };
}
