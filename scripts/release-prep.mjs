// Release helper for CI.
//   node scripts/release-prep.mjs version [explicit]   -> sets tauri.conf.json version, prints it
//   node scripts/release-prep.mjs collect <version>    -> copies installers to release/ with fixed
//                                                         names and writes latest.json if signed
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const repo = process.env.GITHUB_REPOSITORY || 'US-Frame-Factory/easy-peasy-pdf';
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'version') {
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  let v = (arg || '').trim().replace(/^v/, '');
  if (!v) {
    const [maj, min] = conf.version.split('.');
    v = `${maj}.${min}.${process.env.GITHUB_RUN_NUMBER || 0}`;
  }
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`bad version "${v}" (use e.g. 0.2.0)`);
  conf.version = v;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  console.log(v);
} else if (cmd === 'collect') {
  const version = arg;
  const bundle = join(root, 'src-tauri', 'target', 'release', 'bundle');
  const out = join(root, 'release');
  mkdirSync(out, { recursive: true });
  const pick = (sub, ext) => {
    const dir = join(bundle, sub);
    const f = existsSync(dir) && readdirSync(dir).find((n) => n.endsWith(ext) && n.includes(version));
    if (!f) throw new Error(`no ${ext} for ${version} in ${dir}`);
    return join(dir, f);
  };
  const files = { 'QuickFastPDF-setup.exe': pick('nsis', '-setup.exe'), 'QuickFastPDF.msi': pick('msi', '.msi') };
  const platforms = {};
  for (const [name, src] of Object.entries(files)) {
    copyFileSync(src, join(out, name));
    if (existsSync(`${src}.sig`)) {
      const signature = readFileSync(`${src}.sig`, 'utf8').trim();
      const url = `https://github.com/${repo}/releases/download/v${version}/${name}`;
      platforms[name.endsWith('.msi') ? 'windows-x86_64-msi' : 'windows-x86_64-nsis'] = { signature, url };
    }
  }
  if (platforms['windows-x86_64-nsis']) {
    platforms['windows-x86_64'] = platforms['windows-x86_64-nsis']; // default: per-user setup.exe
    const latest = {
      version,
      notes: process.env.RELEASE_NOTES || '',
      pub_date: new Date().toISOString(),
      platforms,
    };
    writeFileSync(join(out, 'latest.json'), JSON.stringify(latest, null, 2));
    console.log('wrote latest.json (signed update)');
  } else {
    console.log('no signatures: release has installers only (no in-app update for it)');
  }
} else {
  throw new Error('usage: release-prep.mjs version [v] | collect <version>');
}
