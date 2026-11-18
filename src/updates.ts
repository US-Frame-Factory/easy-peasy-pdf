// In-app updates: checks GitHub Releases (latest.json) shortly after start and
// every few hours; offers "Update & restart". Updates are signed; the app only
// installs packages signed with the release key.
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, Update } from '@tauri-apps/plugin-updater';

const FIRST_CHECK_MS = 8_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

let busy = false;
let dismissed = '';

function banner(): HTMLElement {
  let b = document.getElementById('update-bar');
  if (!b) {
    b = document.createElement('div');
    b.id = 'update-bar';
    document.getElementById('tabs')!.before(b);
  }
  return b;
}

function hideBanner() {
  document.getElementById('update-bar')?.remove();
}

function show(update: Update) {
  const b = banner();
  b.textContent = '';
  const msg = document.createElement('span');
  msg.textContent = `Easy Peasy PDF ${update.version} is available (you have ${update.currentVersion}).`;
  const go = document.createElement('button');
  go.className = 'primary';
  go.textContent = 'Update & restart';
  go.onclick = () => install(update, msg, go, later);
  const later = document.createElement('button');
  later.textContent = 'Later';
  later.onclick = () => {
    dismissed = update.version;
    hideBanner();
  };
  b.append(msg, go, later);
}

async function install(update: Update, msg: HTMLElement, go: HTMLButtonElement, later: HTMLButtonElement) {
  go.disabled = later.disabled = true;
  let total = 0;
  let got = 0;
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        msg.textContent = total
          ? `Downloading update… ${Math.round((got / total) * 100)}%`
          : `Downloading update… ${(got / 1e6).toFixed(1)} MB`;
      } else if (ev.event === 'Finished') msg.textContent = 'Installing update…';
    });
    // On Windows the installer closes and restarts the app itself.
    msg.textContent = 'Restarting…';
    await relaunch();
  } catch (e) {
    msg.textContent = `Update failed: ${e}`;
    go.disabled = later.disabled = false;
  }
}

/** Returns a short status for manual checks. */
export async function checkForUpdates(manual = false): Promise<string> {
  if (busy) return 'Already checking…';
  busy = true;
  try {
    const update = await check();
    if (!update) return 'You have the latest version.';
    if (manual || update.version !== dismissed) show(update);
    return `Version ${update.version} is available.`;
  } catch (e) {
    return `Couldn't check for updates: ${e}`;
  } finally {
    busy = false;
  }
}

export async function initUpdates(toast: (msg: string, err?: boolean) => void) {
  const btn = document.getElementById('btn-version') as HTMLButtonElement | null;
  try {
    const v = await getVersion();
    if (btn) btn.textContent = `v${v}`;
  } catch {
    /* not fatal */
  }
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      const msg = await checkForUpdates(true);
      btn.disabled = false;
      if (!msg.startsWith('Version')) toast(msg, msg.startsWith("Couldn't"));
    };
  }
  setTimeout(() => checkForUpdates(false), FIRST_CHECK_MS);
  setInterval(() => checkForUpdates(false), EVERY_MS);
}
