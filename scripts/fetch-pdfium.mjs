// Downloads a pinned PDFium build from bblanchon/pdfium-binaries into src-tauri/pdfium/.
// Usage: node scripts/fetch-pdfium.mjs [--force]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match the PDFium API version pdfium-render's `pdfium_latest` feature targets (0.9.x -> 8125).
const PDFIUM_TAG = 'chromium/8125';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'pdfium');

const targets = {
  'win32-x64': ['pdfium-win-x64.tgz', 'bin/pdfium.dll', 'pdfium.dll'],
  'win32-arm64': ['pdfium-win-arm64.tgz', 'bin/pdfium.dll', 'pdfium.dll'],
  'linux-x64': ['pdfium-linux-x64.tgz', 'lib/libpdfium.so', 'libpdfium.so'],
  'linux-arm64': ['pdfium-linux-arm64.tgz', 'lib/libpdfium.so', 'libpdfium.so'],
  'darwin-x64': ['pdfium-mac-x64.tgz', 'lib/libpdfium.dylib', 'libpdfium.dylib'],
  'darwin-arm64': ['pdfium-mac-arm64.tgz', 'lib/libpdfium.dylib', 'libpdfium.dylib'],
};

const key = `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) {
  console.error(`No PDFium build configured for ${key}`);
  process.exit(1);
}
const [asset, inner, libName] = target;
const dest = join(outDir, libName);
if (existsSync(dest) && !process.argv.includes('--force')) {
  console.log(`PDFium already present: ${dest} (use --force to re-download)`);
  process.exit(0);
}

const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(PDFIUM_TAG)}/${asset}`;
const work = mkdtempSync(join(tmpdir(), 'pdfium-'));
const tgz = join(work, asset);
console.log(`Downloading ${url}`);
try {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
} catch (e) {
  console.log(`fetch failed (${e.message}); retrying with curl`);
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', tgz, url], { stdio: 'inherit' });
}
execFileSync('tar', ['-xzf', asset], { cwd: work, stdio: 'inherit' });
mkdirSync(outDir, { recursive: true });
copyFileSync(join(work, inner), dest);
copyFileSync(join(work, 'LICENSE'), join(outDir, 'PDFIUM_LICENSE'));
rmSync(work, { recursive: true, force: true });
console.log(`PDFium (${PDFIUM_TAG}) -> ${dest}`);
