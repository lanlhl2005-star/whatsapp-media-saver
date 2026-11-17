/**
 * Baileys 6.7.19+ uses `import … with { type: 'json' }`, which needs Node 20.10+.
 * Rewrite those two static imports to createRequire so Node 20.9 can load Baileys.
 * Idempotent — safe to re-run on every npm install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baileysRoot = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');

const patches = [
  {
    rel: path.join('lib', 'Defaults', 'index.js'),
    needle: "import defaultVersion from './baileys-version.json' with { type: 'json' };",
    replacement: [
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
      "const defaultVersion = require('./baileys-version.json');",
    ].join('\n'),
  },
  {
    rel: path.join('lib', 'Utils', 'generics.js'),
    needle: "import version from '../Defaults/baileys-version.json' with { type: 'json' };",
    replacement: [
      "import { createRequire } from 'module';",
      "const require = createRequire(import.meta.url);",
      "const version = require('../Defaults/baileys-version.json');",
    ].join('\n'),
  },
];

if (!fs.existsSync(baileysRoot)) {
  console.warn('[patch-baileys] @whiskeysockets/baileys not installed; skip');
  process.exit(0);
}

let changed = 0;
for (const { rel, needle, replacement } of patches) {
  const file = path.join(baileysRoot, rel);
  if (!fs.existsSync(file)) {
    console.warn(`[patch-baileys] missing ${rel}; skip`);
    continue;
  }
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(needle)) {
    if (before.includes('createRequire(import.meta.url)')) {
      continue; // already patched
    }
    if (!before.includes("with { type: 'json' }")) {
      continue; // older Baileys without import attributes
    }
    console.warn(`[patch-baileys] unexpected content in ${rel}; skip`);
    continue;
  }
  fs.writeFileSync(file, before.replace(needle, replacement));
  changed += 1;
}

if (changed > 0) {
  console.log(`[patch-baileys] rewrote ${changed} JSON import attribute(s) for Node 20.9`);
}
