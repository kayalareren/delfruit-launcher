const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session, shell } = require('electron');
const { gamePage, fetchGame, screenshotKey } = require('./delfruit');
const { PROFILE_ID, readBackup, matchesGame, gameProgress, installerFolders } = require('./profile-data');
const { languages, translate } = require('./renderer/locale');
const { normalizeGameAudio, updateAudioConfig, readAudioConfig, applyGameAudio } = require('./game-audio');
const { defaults: controlDefaults, virtualKey, normalizeBindings, mappingArgs,
  normalizeGamepadBindings, gamepadMappingArgs } = require('./game-controls');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const yauzl = require('yauzl');
const { pipeline } = require('node:stream/promises');

const SITE = 'https://delicious-fruit.com/';
protocol.registerSchemesAsPrivileged([{ scheme: 'delfruit-cover', privileges: { standard: true, secure: true } }]);
function webUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

let mainWindow;
let virtualPointerVisible = false;
let libraryFile;
let defaultGamesRoot;
let defaultDownloadsRoot;
let settingsFile;
let collectionsFile;
let collections = [];
let pendingCollectionWrite = Promise.resolve();
function updateCollections(update) {
  const write = pendingCollectionWrite.then(async () => {
    const next = update(collections);
    const temporary = `${collectionsFile}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(temporary, collectionsFile);
    collections = next;
  });
  pendingCollectionWrite = write.catch(() => {});
  return write;
}
let folders;
let theme = 'night';
let rememberLogin = true;
let restoredProgress = [];
let keybindings = { ...controlDefaults };
let gamepadBindings = normalizeGamepadBindings();
let controlsEnabled = true;
let gameAudio = normalizeGameAudio();
let fullscreenOnLaunch = false;
let metadataEnabled = true;
let libraryLayout = 'standard';
const libraryLayouts = new Set(['compact', 'standard', 'large', 'list']);
const defaultCardFields = Object.freeze({
  thumbnail: true, rating: true, ratingCount: true, difficulty: true,
  personalRating: true, tags: true, installedAt: true, playTime: true
});
let cardFields = { ...defaultCardFields };

function normalizeCardFields(value) {
  return Object.fromEntries(Object.keys(defaultCardFields).map((key) => [key, value?.[key] !== false]));
}
let profileDataBusy = false;
let profileRegistry = { active: null, profiles: [], language: null };
const local = (text) => translate(profileRegistry.language ?? 'tr', text);

function showMessage(options, subject) {
  const translated = { ...options };
  for (const field of ['title', 'message', 'detail']) {
    if (typeof translated[field] === 'string') translated[field] = local(translated[field]);
  }
  if (translated.buttons) translated.buttons = translated.buttons.map(local);
  if (subject !== undefined) translated.message = subject;
  return dialog.showMessageBox(mainWindow, translated);
}
let profilesFile;
let activeProfile;
let browserSession;
let activeDownloads = 0;
let activeInstalls = 0;
let profileSwitching = false;
const titleBars = {
  night: { color: '#0b1020', symbolColor: '#f8fafc', height: 41 },
  light: { color: '#eef1fa', symbolColor: '#202a42', height: 41 },
  arcade: { color: '#221339', symbolColor: '#f8fafc', height: 41 },
  forest: { color: '#10271f', symbolColor: '#e5ffef', height: 41 },
  ocean: { color: '#112b42', symbolColor: '#edf9ff', height: 41 },
  sunset: { color: '#3a1e27', symbolColor: '#fff5e9', height: 41 }
};
const themes = new Set(Object.keys(titleBars));
let pendingSettingsWrite = Promise.resolve();

function saveSettings(changes) {
  const write = pendingSettingsWrite.then(async () => {
    const current = { ...folders, theme, rememberLogin, restoredProgress, keybindings, gamepadBindings, controlsEnabled, libraryLayout, cardFields, gameAudio, fullscreenOnLaunch, metadataEnabled };
    const next = { ...current, ...(typeof changes === 'function' ? changes(current) : changes) };
    const temporary = `${settingsFile}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(temporary, settingsFile);
    folders = { downloads: next.downloads, games: next.games };
    theme = next.theme;
    rememberLogin = next.rememberLogin;
    restoredProgress = next.restoredProgress;
    keybindings = next.keybindings;
    gamepadBindings = next.gamepadBindings;
    controlsEnabled = next.controlsEnabled;
    libraryLayout = next.libraryLayout;
    cardFields = next.cardFields;
    gameAudio = next.gameAudio;
    fullscreenOnLaunch = next.fullscreenOnLaunch;
    metadataEnabled = next.metadataEnabled;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(titleBars[theme]);
  });
  pendingSettingsWrite = write.catch(() => {});
  return write;
}
let pendingLibraryWrite = Promise.resolve();
const playing = new Map();
const downloadSources = new WeakMap();
let metadataRefresh = Promise.resolve();

function partitionFor(profile) {
  return profile.legacy ? 'persist:delfruit' : `persist:delfruit-${profile.id}`;
}

let pendingCookieWrite = Promise.resolve();
function syncRememberedLogin() {
  if (!browserSession) return Promise.resolve();
  const cookies = browserSession.cookies;
  const write = pendingCookieWrite.then(async () => {
    const entries = await cookies.get({ name: 'session', domain: 'delicious-fruit.com' });
    for (const cookie of entries) {
      const host = cookie.domain?.replace(/^\./, '');
      if (!['delicious-fruit.com', 'www.delicious-fruit.com'].includes(host) ||
          cookie.session !== rememberLogin) continue;
      const details = {
        url: `https://${host}${cookie.path || '/'}`, name: cookie.name, value: cookie.value,
        path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite
      };
      if (!cookie.hostOnly) details.domain = cookie.domain;
      if (rememberLogin) details.expirationDate = Date.now() / 1000 + 30 * 24 * 60 * 60;
      await cookies.set(details);
    }
    await cookies.flushStore();
  });
  pendingCookieWrite = write.catch((error) => console.error('Oturum çerezi ayarlanamadı:', error.message));
  return write;
}

function applyProgress(game, record) {
  game.favorite = record.favorite;
  game.completed = record.completed;
  game.personalRating = record.personalRating;
  game.playTimeMs = record.playTimeMs;
  game.launchCount = record.launchCount;
  game.collectionIds = record.collectionIds;
  if (!game.sourcePage) game.sourcePage = gamePage(record.sourcePage);
}

function safeName(value) {
  return String(value || 'Fangame')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim().slice(0, 80) || 'Fangame';
}

async function readLibrary() {
  try {
    const value = JSON.parse(await fsp.readFile(libraryFile, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Library read failed:', error);
    return [];
  }
}

async function writeLibrary(games) {
  await fsp.mkdir(path.dirname(libraryFile), { recursive: true });
  const temporary = `${libraryFile}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(games, null, 2), 'utf8');
  await fsp.rename(temporary, libraryFile);
}

function updateLibrary(update) {
  const write = pendingLibraryWrite.then(async () => {
    const games = await readLibrary();
    await update(games);
    await writeLibrary(games);
  });
  pendingLibraryWrite = write.catch(() => {});
  return write;
}

function elapsed(session) {
  return session?.started === undefined ? 0 : Math.floor(performance.now() - session.started);
}

function libraryChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library-changed');
}

async function findExecutables(root) {
  const result = [];
  async function walk(dir, depth = 0) {
    if (depth > 5 || result.length > 100) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.exe$/i.test(entry.name) && !/(unins|setup|install|crash|report|update)/i.test(entry.name)) result.push(full);
    }
  }
  await walk(root);
  return result;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function importGameFolder(source, storageRoot) {
  const executables = await findExecutables(source);
  if (!executables.length) return null;
  let executable = executables[0];
  if (executables.length > 1) {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: local('Oyunun ana çalıştırılabilir dosyasını seçin'),
      defaultPath: executable,
      properties: ['openFile'],
      filters: [{ name: local('Çalıştırılacak dosya'), extensions: ['exe'] }]
    });
    if (selection.canceled) return null;
    executable = path.resolve(selection.filePaths[0]);
    if (!executables.some((file) => path.relative(file, executable) === '')) {
      throw new Error('Seçilen çalıştırılabilir dosya oyun klasörüne ait değil.');
    }
  }
  const name = safeName(path.basename(source));
  const id = crypto.randomUUID();
  const folder = path.join(storageRoot, `${name}-${id.slice(0, 8)}`);
  if (source === storageRoot || isInside(source, storageRoot) || isInside(source, folder)) {
    throw new Error('Oyun depolama klasörünü içeren bir klasör kaynak olarak seçilemez.');
  }
  await fsp.mkdir(folder, { recursive: false });
  try {
    for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      await fsp.cp(path.join(source, entry.name), path.join(folder, entry.name), {
        recursive: true, force: false, errorOnExist: true,
        filter: async (filename) => {
          const info = await fsp.lstat(filename);
          return info.isFile() || info.isDirectory();
        }
      });
    }
    const copiedExecutable = path.join(folder, path.relative(source, executable));
    if (!(await fsp.lstat(copiedExecutable)).isFile()) throw new Error('Oyun dosyası bulunamadı.');
    const game = { id, name, folder, storageRoot, executable: copiedExecutable, installedAt: new Date().toISOString() };
    const restored = restoredProgress.find((record) => matchesGame(record, game, gamePage));
    if (restored) applyProgress(game, restored);
    await updateLibrary((games) => games.push(game));
    return game;
  } catch (error) {
    await fsp.rm(folder, { recursive: true, force: true });
    throw error;
  }
}

function coverPath(id) {
  return activeProfile && PROFILE_ID.test(id) ? path.join(profileRoot(activeProfile), 'Thumbnails', `${id}.png`) : null;
}

function screenshotPath(profile, key) {
  return profile && /^\d{1,12}_[0-9a-f]{8,14}$/.test(key)
    ? path.join(profileRoot(profile), 'DelFruitThumbnails', `${key}.png`) : null;
}

async function cacheScreenshot(profile, url, request) {
  const key = screenshotKey(url);
  if (!key) return;
  const filename = screenshotPath(profile, key);
  if (fs.existsSync(filename)) return;
  const response = await request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  const limit = 12 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('DelFruit screenshot could not be read.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('DelFruit screenshot is too large.');
    chunks.push(chunk);
  }
  let image = nativeImage.createFromBuffer(Buffer.concat(chunks, size));
  if (image.isEmpty()) throw new Error('DelFruit screenshot could not be decoded.');
  const { width, height } = image.getSize();
  if (Math.max(width, height) > 1280) image = image.resize(width >= height ? { width: 1280 } : { height: 1280 });
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, image.toPNG(), { flag: 'wx' });
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.unlink(temporary).catch(() => {});
  }
}

function extractZipSafely(zipPath, target) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error, zip) => {
      if (settled) return;
      settled = true;
      try { zip?.close(); } catch {}
      reject(error);
    };
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) return fail(openError);
      let extractedBytes = 0;
      const maxExtractedBytes = 30 * 1024 * 1024 * 1024;
      zip.on('error', (error) => fail(error, zip));
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', async (entry) => {
        try {
          const normalized = entry.fileName.replace(/\\/g, '/');
          if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
            throw new Error('Arşiv güvenli olmayan bir dosya yolu içeriyor.');
          }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0o170000) === 0o120000) throw new Error('Arşivde sembolik bağlantı bulundu; güvenlik nedeniyle kurulmadı.');
          extractedBytes += entry.uncompressedSize;
          if (extractedBytes > maxExtractedBytes) throw new Error('Açılmış arşiv 30 GB güvenlik sınırını aşıyor.');
          const destination = path.resolve(target, normalized);
          if (!isInside(target, destination)) throw new Error('Arşiv kurulum klasörünün dışına çıkmaya çalışıyor.');
          if (/\/$/.test(normalized)) {
            await fsp.mkdir(destination, { recursive: true });
            zip.readEntry();
            return;
          }
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          zip.openReadStream(entry, async (streamError, readStream) => {
            if (streamError) return fail(streamError, zip);
            try {
              await pipeline(readStream, fs.createWriteStream(destination, { flags: 'wx' }));
              zip.readEntry();
            } catch (error) { fail(error, zip); }
          });
        } catch (error) { fail(error, zip); }
      });
      zip.readEntry();
    });
  });
}

async function installZip(zipPath, requestedName, sourcePage = null) {
  const ext = path.extname(zipPath).toLowerCase();
  if (ext !== '.zip') throw new Error('Şimdilik yalnızca ZIP arşivleri otomatik kurulabilir.');
  const stats = await fsp.stat(zipPath);
  if (stats.size > 15 * 1024 * 1024 * 1024) throw new Error('Arşiv 15 GB sınırını aşıyor.');

  const id = crypto.randomUUID();
  const name = safeName(requestedName || path.basename(zipPath, ext));
  const storageRoot = folders.games;
  await fsp.mkdir(storageRoot, { recursive: true });
  const target = path.join(storageRoot, `${name}-${id.slice(0, 8)}`);
  await fsp.mkdir(target, { recursive: false });
  try {
    await extractZipSafely(zipPath, target);
    const executables = await findExecutables(target);
    if (!executables.length) throw new Error('Arşivde çalıştırılabilir bir .exe bulunamadı.');
    let executable = executables[0];
    if (executables.length > 1) {
      const choice = await showMessage({
        type: 'question', title: 'Çalıştırılacak dosya', message: 'Oyunun ana çalıştırılabilir dosyasını seçin',
        detail: executables.map((x, i) => `${i + 1}. ${path.relative(target, x)}`).join('\n'),
        buttons: executables.map((x) => path.basename(x)), cancelId: -1, noLink: true
      });
      if (choice.response < 0 || !executables[choice.response]) throw new Error('Kurulum iptal edildi.');
      executable = executables[choice.response];
    }
    const game = { id, name, folder: target, storageRoot, executable, sourceZip: zipPath, sourcePage, installedAt: new Date().toISOString() };
    const restored = restoredProgress.find((record) => matchesGame(record, game, gamePage));
    if (restored) applyProgress(game, restored);
    await updateLibrary((games) => games.push(game));
    void refreshGameMetadata([id]).catch(console.error);
    return game;
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true });
    throw error;
  }
}

function refreshGameMetadata(ids) {
  const profile = activeProfile;
  const enabled = () => metadataEnabled && activeProfile === profile;
  const disabled = { failedGames: [], disabled: true };
  if (!enabled()) return Promise.resolve(disabled);
  const selected = ids && new Set(ids);
  const refresh = metadataRefresh.then(async () => {
    if (!enabled()) return disabled;
    const byPage = new Map();
    for (const game of await readLibrary()) {
      if (selected && !selected.has(game.id)) continue;
      const page = gamePage(game.sourcePage);
      if (!page) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push(game);
    }
    const pages = [...byPage.keys()];
    const failedGames = [];
    for (let offset = 0; offset < pages.length && enabled(); offset += 4) {
      const batch = pages.slice(offset, offset + 4);
      const request = (url, options) => {
        if (!enabled()) throw new Error('DelFruit metadata is disabled.');
        return net.fetch(url, options);
      };
      const results = await Promise.allSettled(batch.map(async (page) => {
        const metadata = await fetchGame(page, request);
        let coverFailed = false;
        try { await cacheScreenshot(profile, metadata.thumbnail, request); }
        catch (error) {
          coverFailed = true;
          console.error('DelFruit kapak görseli alınamadı:', error.message);
        }
        return { metadata, coverFailed };
      }));
      if (!enabled()) return disabled;
      const updates = new Map();
      for (const [index, result] of results.entries()) {
        const page = batch[index];
        for (const game of byPage.get(page)) {
          if (result.status === 'fulfilled') updates.set(game.id, { page, metadata: result.value.metadata });
          if (result.status === 'rejected' || result.value.coverFailed) failedGames.push(game.name);
        }
      }
      if (updates.size) {
        await updateLibrary((games) => {
          if (!enabled()) return;
          for (const game of games) {
            const update = updates.get(game.id);
            if (update && gamePage(game.sourcePage) === update.page) {
              const oldKey = screenshotKey(game.metadata?.thumbnail);
              const newKey = screenshotKey(update.metadata.thumbnail);
              if (newKey && oldKey && !fs.existsSync(screenshotPath(profile, newKey)) &&
                  fs.existsSync(screenshotPath(profile, oldKey))) update.metadata.thumbnail = game.metadata.thumbnail;
              game.metadata = update.metadata;
            }
          }
        });
        libraryChanged();
      }
    }
    return enabled() ? { failedGames } : disabled;
  });
  metadataRefresh = refresh.catch(() => {});
  return refresh;
}

function setupDownloads(downloadSession) {
  downloadSession.on('will-download', (_event, item, guest) => {
    const sourcePage = guest ? gamePage(guest.getURL()) ?? downloadSources.get(guest) ?? null : null;
    const filename = item.getFilename();
    const isZip = /\.zip$/i.test(filename);
    const originalName = isZip ? `${safeName(filename.slice(0, -4))}.zip` : safeName(filename);
    const downloadDir = isZip ? folders.downloads : defaultDownloadsRoot;
    try {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.accessSync(downloadDir, fs.constants.W_OK);
    } catch (error) {
      item.cancel();
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('İndirme klasörüne erişilemedi', `${downloadDir}\n${error.message}`);
      }
      return;
    }
    let destination = path.join(downloadDir, originalName);
    if (fs.existsSync(destination)) {
      const ext = path.extname(originalName);
      destination = path.join(downloadDir, `${path.basename(originalName, ext)}-${Date.now()}${ext}`);
    }
    item.setSavePath(destination);
    activeDownloads++;
    mainWindow?.webContents.send('download-started', { name: originalName, total: item.getTotalBytes() });
    item.on('updated', (_e, state) => mainWindow?.webContents.send('download-progress', {
      name: originalName, received: item.getReceivedBytes(), total: item.getTotalBytes(), state
    }));
    item.once('done', async (_e, state) => {
      activeDownloads--;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow?.webContents.send('download-finished', { name: originalName, path: destination, state });
      if (state !== 'completed' || path.extname(destination).toLowerCase() !== '.zip') return;
      const result = await showMessage({
        type: 'question', title: 'İndirme tamamlandı',
        detail: 'Arşivi şimdi kütüphaneye kurmak ister misiniz?', buttons: ['Kur', 'Klasörde göster', 'Daha sonra'],
        defaultId: 0, cancelId: 2
      }, originalName);
      if (result.response === 1) return shell.showItemInFolder(destination);
      if (result.response !== 0) return;
      activeInstalls++;
      try {
        await installZip(destination, path.basename(originalName, '.zip'), sourcePage);
        mainWindow?.webContents.send('library-changed');
      } catch (error) {
        dialog.showErrorBox(local('Kurulum başarısız'), local(error.message));
      } finally {
        activeInstalls--;
      }
    });
  });
}

function gameControlsPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'GameControls.exe') :
    path.join(__dirname, '..', 'work', 'native', 'GameControls.exe');
}

function watchBrowserArrows(window) {
  if (process.platform !== 'win32') return;
  const helper = spawn(gameControlsPath(), ['browser-arrows', String(process.pid)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
  });
  let state = null;
  const publish = () => {
    if (!window.isDestroyed()) window.webContents.send('browser-arrow-state', state);
  };
  helper.stdout.on('data', (bytes) => {
    const latest = bytes[bytes.length - 1];
    if (latest <= 15) {
      state = latest;
      publish();
    }
  });
  const stopped = () => {
    state = null;
    publish();
  };
  helper.once('error', stopped);
  helper.once('exit', stopped);
  window.webContents.on('did-finish-load', publish);
  window.once('closed', () => helper.kill());
}

function createWindow() {
  virtualPointerVisible = false;
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'renderer', 'assets', 'fruit-icon.png'),
    width: 1440, height: 900, minWidth: 980, minHeight: 650,
    backgroundColor: titleBars[theme].color, titleBarStyle: 'hidden', titleBarOverlay: titleBars[theme],
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      webviewTag: true, sandbox: true
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  watchBrowserArrows(mainWindow);
  for (const event of ['focus', 'blur']) {
    mainWindow.on(event, () => mainWindow?.webContents.send('window-focus', event === 'focus'));
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const arrows = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', (event, input) => {
      const key = arrows.has(input.code) ? input.code : input.key;
      if (input.type === 'keyUp' && arrows.has(key)) {
        event.preventDefault();
        mainWindow?.webContents.send('browser-pointer-key', { key, down: false });
        return;
      }
      if (input.type !== 'keyDown' || input.isComposing) return;
      if (input.key === 'F6') {
        event.preventDefault();
        mainWindow?.webContents.focus();
        mainWindow?.webContents.send('focus-navigation');
        return;
      }
      if (input.alt || input.control || input.meta || input.shift) return;
      const click = input.key === 'Enter' && virtualPointerVisible;
      if (!arrows.has(key) && !click && key !== 'PageUp' && key !== 'PageDown') return;
      event.preventDefault();
      mainWindow?.webContents.send('browser-pointer-key', {
        key, down: true, repeat: input.isAutoRepeat
      });
    });
    const rememberSource = () => {
      const page = gamePage(guest.getURL());
      if (page) downloadSources.set(guest, page);
    };
    guest.on('will-navigate', rememberSource);
    guest.on('did-start-navigation', (event, legacyUrl, _inPlace, legacyMainFrame) => {
      const url = event.url ?? legacyUrl;
      if ((event.isMainFrame ?? legacyMainFrame) && /^https?:\/\/(www\.)?delicious-fruit\.com\//i.test(url)) {
        downloadSources.delete(guest);
      }
    });
    guest.setWindowOpenHandler(({ url, referrer }) => {
      const destination = webUrl(url);
      if (destination) {
        rememberSource();
        const options = webUrl(referrer?.url) ? { httpReferrer: referrer } : {};
        setImmediate(() => {
          if (!guest.isDestroyed()) guest.loadURL(destination, options).catch(() => {});
        });
      }
      return { action: 'deny' };
    });
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function profileRoot(profile) {
  const userData = app.getPath('userData');
  return profile.legacy ? userData : path.join(userData, 'Profiles', profile.id);
}

async function profileDefaults(root) {
  const initialFolders = installerFolders(await fsp.readFile(
    path.join(path.dirname(process.execPath), 'storage-defaults.txt')
  ).catch(() => null));
  return {
    games: initialFolders.games ?? path.join(root, 'Games'),
    downloads: initialFolders.downloads ?? path.join(app.getPath('downloads'), 'DelFruit Launcher'),
    theme: 'night', rememberLogin: true, restoredProgress: [],
    keybindings: { ...controlDefaults }, gamepadBindings: normalizeGamepadBindings(),
    controlsEnabled: true, libraryLayout: 'standard',
    cardFields: { ...defaultCardFields }, gameAudio: normalizeGameAudio(),
    fullscreenOnLaunch: false, metadataEnabled: true
  };
}

async function loadProfile(profile) {
  activeProfile = profile;
  const root = profileRoot(profile);
  await fsp.mkdir(root, { recursive: true });
  libraryFile = path.join(root, 'library.json');
  settingsFile = path.join(root, 'settings.json');
  collectionsFile = path.join(root, 'collections.json');
  const defaults = await profileDefaults(root);
  defaultGamesRoot = defaults.games;
  defaultDownloadsRoot = defaults.downloads;
  folders = { downloads: defaultDownloadsRoot, games: defaultGamesRoot };
  try {
    const saved = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
    for (const key of Object.keys(folders)) {
      if (typeof saved?.[key] === 'string' && path.isAbsolute(saved[key])) folders[key] = saved[key];
    }
    if (themes.has(saved?.theme)) theme = saved.theme;
    rememberLogin = saved?.rememberLogin !== false;
    if (Array.isArray(saved?.restoredProgress)) restoredProgress = saved.restoredProgress;
    keybindings = normalizeBindings(saved?.keybindings);
    gamepadBindings = normalizeGamepadBindings(saved?.gamepadBindings);
    controlsEnabled = saved?.controlsEnabled !== false;
    if (libraryLayouts.has(saved?.libraryLayout)) libraryLayout = saved.libraryLayout;
    cardFields = normalizeCardFields(saved?.cardFields);
    gameAudio = normalizeGameAudio(saved?.gameAudio);
    fullscreenOnLaunch = saved?.fullscreenOnLaunch === true;
    metadataEnabled = saved?.metadataEnabled !== false;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Ayarlar okunamadı:', error);
  }
  try {
    const saved = JSON.parse(await fsp.readFile(collectionsFile, 'utf8'));
    if (Array.isArray(saved)) collections = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Koleksiyonlar okunamadı:', error);
  }
  browserSession = session.fromPartition(partitionFor(profile));
  browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (cookie.name === 'session' && !removed && cookie.session === rememberLogin) {
      void syncRememberedLogin().catch(() => {});
    }
  });
  await syncRememberedLogin().catch(() => {});
  setupDownloads(browserSession);
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  protocol.handle('delfruit-cover', async (request) => {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);
    const filename = url.hostname === 'cover' ? coverPath(key) :
      url.hostname === 'screenshot' ? screenshotPath(activeProfile, key) : null;
    if (!filename) return new Response(null, { status: 404 });
    try {
      return new Response(await fsp.readFile(filename), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
      });
    } catch { return new Response(null, { status: 404 }); }
  });
  profilesFile = path.join(app.getPath('userData'), 'profiles.json');
  try {
    const saved = JSON.parse(await fsp.readFile(profilesFile, 'utf8'));
    if (Array.isArray(saved?.profiles)) {
      profileRegistry = {
        active: saved.active,
        language: Object.hasOwn(languages, saved.language) ? saved.language : null,
        profiles: saved.profiles.filter((profile) => PROFILE_ID.test(profile?.id ?? '') && typeof profile.name === 'string')
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Profiller okunamadı:', error.message);
  }
  const profile = profileRegistry.profiles.find((entry) => entry.id === profileRegistry.active) ??
    (profileRegistry.profiles.length === 1 ? profileRegistry.profiles[0] : null);
  if (profile) await loadProfile(profile);
  createWindow();
  app.on('second-instance', () => {
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
function quitWhenIdle() {
  if (process.platform !== 'darwin' && !playing.size && !BrowserWindow.getAllWindows().length) app.quit();
}
app.on('window-all-closed', quitWhenIdle);

function requireIdle() {
  if (playing.size || activeDownloads || activeInstalls) {
    throw new Error('Önce açık oyunları kapat ve indirme veya kurulumların bitmesini bekle.');
  }
}

let pendingRegistryWrite = Promise.resolve();
function saveRegistry(next) {
  const write = pendingRegistryWrite.then(async () => {
    const state = { ...profileRegistry, ...next };
    const temporary = `${profilesFile}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(temporary, profilesFile);
    profileRegistry = state;
  });
  pendingRegistryWrite = write.catch(() => {});
  return write;
}

async function changeProfile(next) {
  if (profileSwitching) return;
  if (profileDataBusy) throw new Error('Önce profil veri işleminin bitmesini bekle.');
  requireIdle();
  profileSwitching = true;
  try {
    await Promise.all([pendingSettingsWrite, pendingCollectionWrite, pendingLibraryWrite, pendingCookieWrite]);
    requireIdle();
    await saveRegistry(next);
    app.relaunch();
    app.quit();
  } finally {
    profileSwitching = false;
  }
}

ipcMain.handle('app:get-language', () => profileRegistry.language);
ipcMain.handle('app:set-language', async (event, language) => {
  if (event.sender !== mainWindow?.webContents || !Object.hasOwn(languages, language)) return false;
  await saveRegistry({ language });
  return true;
});
ipcMain.handle('profiles:list', () => ({ profiles: profileRegistry.profiles, active: activeProfile?.id ?? null,
  partition: activeProfile ? partitionFor(activeProfile) : null }));
ipcMain.handle('profiles:create', async (_event, value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60) throw new Error('1–60 karakterlik bir profil adı gir.');
  if (profileRegistry.profiles.some((profile) => profile.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'))) {
    throw new Error('Bu isimde bir profil var.');
  }
  const legacy = !profileRegistry.profiles.length && ['library.json', 'settings.json', 'collections.json']
    .some((file) => fs.existsSync(path.join(app.getPath('userData'), file)));
  const profile = { id: crypto.randomUUID(), name, legacy };
  await changeProfile({ active: profile.id, profiles: [...profileRegistry.profiles, profile] });
});
ipcMain.handle('profiles:select', async (_event, id) => {
  if (!profileRegistry.profiles.some((profile) => profile.id === id)) throw new Error('Profil bulunamadı.');
  if (id !== activeProfile?.id) await changeProfile({ ...profileRegistry, active: id });
});

ipcMain.handle('library:list', async () => (await readLibrary()).map((game) => {
  const session = playing.get(game.id);
  return {
    ...game, completed: game.completed === true,
    playTimeMs: (game.playTimeMs ?? 0) + (session?.finishedMs ?? elapsed(session)),
    running: session?.started !== undefined && session.finishedMs === undefined
  };
}));
ipcMain.handle('app:window-focused', () => mainWindow?.isFocused() ?? false);
ipcMain.on('app:pointer-visible', (event, visible) => {
  if (event.sender === mainWindow?.webContents && typeof visible === 'boolean') virtualPointerVisible = visible;
});
ipcMain.handle('settings:launch-options', () => ({ fullscreenOnLaunch, metadataEnabled }));
ipcMain.handle('settings:set-launch-option', async (event, key, value) => {
  if (!activeProfile || event.sender !== mainWindow?.webContents || typeof value !== 'boolean' ||
      !['fullscreenOnLaunch', 'metadataEnabled'].includes(key)) return false;
  await saveSettings({ [key]: value });
  return true;
});
ipcMain.handle('library:refresh-metadata', () => refreshGameMetadata());
ipcMain.handle('library:set-source', async (_event, id, value) => {
  const sourcePage = gamePage(value);
  if (!sourcePage) throw new Error('Geçerli bir DelFruit oyun sayfası gir.');
  await updateLibrary((games) => {
    const game = games.find((item) => item.id === id);
    if (!game) throw new Error('Oyun bulunamadı.');
    if (gamePage(game.sourcePage) !== sourcePage) delete game.metadata;
    game.sourcePage = sourcePage;
    const archived = restoredProgress.find((record) => gamePage(record.sourcePage) === sourcePage);
    if (archived) game.playTimeMs = Math.max(game.playTimeMs ?? 0, archived.playTimeMs ?? 0);
  });
});
ipcMain.handle('library:complete', async (_event, id, completed) => {
  if (typeof completed !== 'boolean') throw new Error('Geçersiz tamamlanma işareti.');
  await updateLibrary((games) => {
    const game = games.find((item) => item.id === id);
    if (!game) throw new Error('Oyun bulunamadı.');
    game.completed = completed;
  });
});
ipcMain.handle('library:favorite', async (_event, id, favorite) => {
  if (typeof favorite !== 'boolean') throw new Error('Geçersiz favori seçimi.');
  await updateLibrary((games) => {
    const game = games.find((item) => item.id === id);
    if (!game) throw new Error('Oyun bulunamadı.');
    game.favorite = favorite;
  });
});
ipcMain.handle('library:personal-rating', async (_event, id, rating) => {
  if (rating !== null && (!Number.isInteger(rating) || rating < 0 || rating > 10)) {
    throw new Error('0–10 arasında bir puan seç.');
  }
  await updateLibrary((games) => {
    const game = games.find((item) => item.id === id);
    if (!game) throw new Error('Oyun bulunamadı.');
    game.personalRating = rating;
  });
});
ipcMain.handle('collections:list', () => collections);
ipcMain.handle('collections:create', async (_event, value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 60) throw new Error('1–60 karakterlik bir koleksiyon adı gir.');
  const entry = { id: crypto.randomUUID(), name };
  await updateCollections((current) => {
    if (current.some((item) => item.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'))) {
      throw new Error('Bu isimde bir koleksiyon var.');
    }
    return [...current, entry];
  });
  return entry;
});
ipcMain.handle('collections:membership', async (_event, gameId, collectionId, checked) => {
  if (typeof checked !== 'boolean' || !collections.some((item) => item.id === collectionId)) {
    throw new Error('Koleksiyon bulunamadı.');
  }
  await updateLibrary((games) => {
    const game = games.find((item) => item.id === gameId);
    if (!game) throw new Error('Oyun bulunamadı.');
    const memberships = new Set(game.collectionIds ?? []);
    if (checked) memberships.add(collectionId);
    else memberships.delete(collectionId);
    game.collectionIds = [...memberships];
  });
});
ipcMain.handle('library:install-file', async () => {
  const selected = await dialog.showOpenDialog(mainWindow, {
    defaultPath: fs.existsSync(folders.downloads) ? folders.downloads : app.getPath('downloads'),
    properties: ['openFile'],
    filters: [{ name: local('ZIP arşivi'), extensions: ['zip'] }]
  });
  if (selected.canceled) return null;
  activeInstalls++;
  try { return await installZip(selected.filePaths[0]); }
  finally { activeInstalls--; }
});
ipcMain.handle('library:import-folder', async (event) => {
  if (!activeProfile || event.sender !== mainWindow?.webContents) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: local('Oyun klasörünü seç'), properties: ['openDirectory']
  });
  if (selection.canceled) return null;
  const root = await fsp.realpath(selection.filePaths[0]);
  const mode = await showMessage({
    type: 'question', title: 'Klasörden ekle',
    message: 'Bu klasörü nasıl eklemek istersin?',
    buttons: ['Tek oyun', 'Alt klasörlerden koleksiyon', 'Vazgeç'], cancelId: 2, defaultId: 0
  });
  if (![0, 1].includes(mode.response)) return null;
  const multiple = mode.response === 1;
  const sources = multiple
    ? (await fsp.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
    : [root];
  if (!sources.length) throw new Error('Bu klasörde oyun bulunamadı.');
  const added = [];
  const skipped = [];
  activeInstalls++;
  try {
    const destination = folders.games;
    if (path.relative(root, destination) === '' || isInside(root, destination)) {
      throw new Error('Oyun depolama klasörünü içeren bir klasör kaynak olarak seçilemez.');
    }
    await fsp.mkdir(destination, { recursive: true });
    const storageRoot = await fsp.realpath(destination);
    if (path.relative(root, storageRoot) === '' || isInside(root, storageRoot)) {
      throw new Error('Oyun depolama klasörünü içeren bir klasör kaynak olarak seçilemez.');
    }
    for (const source of sources) {
      try {
        const game = await importGameFolder(source, storageRoot);
        if (game) added.push(game.id);
        else skipped.push(path.basename(source));
      } catch (error) {
        if (!multiple) throw error;
        console.error('Oyun klasörü içe aktarılamadı:', error.message);
        skipped.push(path.basename(source));
      }
    }
    if (multiple && added.length) {
      const name = safeName(path.basename(root)).slice(0, 60);
      let collection;
      await updateCollections((current) => {
        collection = current.find((entry) => entry.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));
        if (collection) return current;
        collection = { id: crypto.randomUUID(), name };
        return [...current, collection];
      });
      const imported = new Set(added);
      await updateLibrary((games) => {
        for (const game of games) {
          if (imported.has(game.id)) game.collectionIds = [...new Set([...(game.collectionIds ?? []), collection.id])];
        }
      });
    }
    if (added.length) {
      libraryChanged();
      void refreshGameMetadata(added).catch(console.error);
    }
    return { added: added.length, skipped };
  } finally { activeInstalls--; }
});

ipcMain.handle('library:custom-cover', async (event, id, clear) => {
  if (event.sender !== mainWindow?.webContents || typeof clear !== 'boolean') return false;
  const filename = coverPath(id);
  if (!filename || !(await readLibrary()).some((game) => game.id === id)) throw new Error('Oyun bulunamadı.');
  let png;
  if (!clear) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: local('Özel kapak seç'), properties: ['openFile'],
      filters: [{ name: 'PNG, JPG', extensions: ['png', 'jpg', 'jpeg'] }]
    });
    if (result.canceled) return false;
    const source = result.filePaths[0];
    if ((await fsp.stat(source)).size > 20 * 1024 * 1024) throw new Error('Kapak dosyası 20 MB sınırını aşıyor.');
    let image = nativeImage.createFromPath(source);
    if (image.isEmpty()) throw new Error('Görsel açılamadı. Bir PNG veya JPG seç.');
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 1280) image = image.resize(width >= height ? { width: 1280 } : { height: 1280 });
    png = image.toPNG();
  }
  await updateLibrary(async (games) => {
    const game = games.find((entry) => entry.id === id);
    if (!game) throw new Error('Oyun bulunamadı.');
    if (clear) {
      await fsp.unlink(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      delete game.customCover;
    } else {
      await fsp.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp`;
      await fsp.writeFile(temporary, png);
      await fsp.rename(temporary, filename);
      game.customCover = Date.now();
    }
  });
  libraryChanged();
  return true;
});
ipcMain.handle('library:launch', async (_event, id) => {
  const game = (await readLibrary()).find((x) => x.id === id);
  if (!game || !isInside(game.folder, game.executable) || !fs.existsSync(game.executable)) throw new Error('Oyun dosyası bulunamadı.');
  if (playing.has(id)) return false;
  const gameSession = {};
  playing.set(id, gameSession);
  if (gameAudio.enabled) {
    try {
      if (!await applyGameAudio(game, gameAudio) && game.audioConfig) notifyAudioFailure(game.name);
    } catch (error) {
      console.error('Oyun ses ayarı uygulanamadı:', error);
      notifyAudioFailure(game.name);
    }
  }
  let child;
  try { child = spawn(game.executable, [], { cwd: path.dirname(game.executable), detached: true, stdio: 'ignore' }); }
  catch (error) {
    playing.delete(id);
    quitWhenIdle();
    throw error;
  }
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      gameSession.started = performance.now();
      startControlHelper(child, game.name);
      void updateLibrary((games) => {
        const record = games.find((item) => item.id === id);
        if (record) record.launchCount = (record.launchCount ?? 0) + 1;
      }).then(libraryChanged).catch(console.error);
      resolve(true);
    });
    child.once('error', (error) => {
      playing.delete(id);
      quitWhenIdle();
      reject(error);
    });
    child.once('exit', async () => {
      gameSession.finishedMs = elapsed(gameSession);
      try {
        await updateLibrary((games) => {
          const record = games.find((item) => item.id === id);
          if (record) record.playTimeMs = (record.playTimeMs ?? 0) + gameSession.finishedMs;
        });
      } catch (error) {
        console.error('Oynama süresi kaydedilemedi:', error);
      } finally {
        playing.delete(id);
        libraryChanged();
        quitWhenIdle();
      }
    });
  });
});

function notifyAudioFailure(name) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('game-audio-unavailable', name);
}

ipcMain.handle('settings:game-audio', () => gameAudio);
ipcMain.handle('settings:save-game-audio', async (event, value) => {
  if (!activeProfile || event.sender !== mainWindow?.webContents) return false;
  await saveSettings({ gameAudio: normalizeGameAudio(value) });
  return true;
});
ipcMain.handle('library:audio-config', async (event, id, clear = false) => {
  if (event.sender !== mainWindow?.webContents) return false;
  const game = (await readLibrary()).find((entry) => entry.id === id);
  if (!game) throw new Error('Oyun bulunamadı.');
  let filename;
  if (!clear) {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: local('Ses ayarı dosyasını seç'),
      defaultPath: game.audioConfig ?? path.dirname(game.executable),
      properties: ['openFile'], filters: [{ name: 'INI, CFG, JSON', extensions: ['ini', 'cfg', 'json'] }]
    });
    if (selection.canceled) return false;
    filename = await fsp.realpath(selection.filePaths[0]);
    const contents = await readAudioConfig(filename);
    if (contents === null || updateAudioConfig(contents, gameAudio) === null) {
      throw new Error('Bu dosyada desteklenen ayrı ses ve müzik ayarları bulunamadı.');
    }
  }
  await updateLibrary((games) => {
    const entry = games.find((item) => item.id === id);
    if (!entry) throw new Error('Oyun bulunamadı.');
    if (filename) entry.audioConfig = filename;
    else delete entry.audioConfig;
  });
  return true;
});

function startControlHelper(child, name) {
  const mappings = controlsEnabled ? [...mappingArgs(keybindings), ...gamepadMappingArgs(gamepadBindings)] : [];
  const args = fullscreenOnLaunch ? [...mappings, 'fullscreen'] : mappings;
  if (!args.length) return;
  const report = (detail, fullscreenFailure = false) => {
    const title = mappings.length && !fullscreenFailure ? 'Kontroller uygulanamadı' : 'Tam ekran açılamadı';
    if (mainWindow && !mainWindow.isDestroyed()) {
      void showMessage({ type: 'error', title, detail, buttons: ['Tamam'] }, name).catch(console.error);
    }
  };
  if (process.platform !== 'win32' || !child.pid) {
    report('Windows oyun yardımcısı başlatılamadı.');
    return;
  }
  let helper;
  try {
    helper = spawn(gameControlsPath(), [String(child.pid), String(process.pid), ...args], {
      windowsHide: true, stdio: 'ignore'
    });
  } catch (error) {
    report(error.message);
    return;
  }
  helper.once('error', (error) => report(error.message));
  helper.once('exit', (code) => {
    if (code === 3) report('Windows klavye eşlemesi başlatılamadı.');
    else if (code === 4) report('Windows eşlenen tuşu oyuna gönderemedi.');
    else if (code === 5) report('Windows F4 tuşunu oyuna gönderemedi.', true);
    else if (code !== 0) report('Windows oyun yardımcısı başlatılamadı.');
  });
  helper.unref();
}

ipcMain.handle('settings:controls', () => ({
  bindings: keybindings, gamepad: gamepadBindings, defaults: controlDefaults, enabled: controlsEnabled
}));
ipcMain.handle('settings:set-controls-enabled', async (event, enabled) => {
  if (!activeProfile || event.sender !== mainWindow?.webContents || typeof enabled !== 'boolean') return false;
  await saveSettings({ controlsEnabled: enabled });
  return true;
});
ipcMain.handle('settings:save-controls', async (event, value, gamepad) => {
  if (!activeProfile || event.sender !== mainWindow?.webContents) return false;
  const values = Object.keys(controlDefaults).map((action) => virtualKey(value?.[action]));
  if (values.some((key) => key === null) || new Set(values).size !== values.length) {
    throw new Error('Her hareket için farklı bir tuş seç.');
  }
  const normalizedPad = normalizeGamepadBindings(gamepad);
  const buttons = Object.values(normalizedPad).filter((button) => button !== null);
  if (new Set(buttons).size !== buttons.length) throw new Error('Her hareket için farklı bir gamepad düğmesi seç.');
  await saveSettings({ keybindings: normalizeBindings(value), gamepadBindings: normalizedPad });
  return true;
});
ipcMain.handle('library:remove', async (_event, id) => {
  const games = await readLibrary();
  const game = games.find((x) => x.id === id);
  const root = game?.storageRoot ?? path.join(app.getPath('userData'), 'Games');
  if (!game || !isInside(root, game.folder) || path.relative(root, game.folder).includes(path.sep) ||
      !path.basename(game.folder).endsWith(`-${id.slice(0, 8)}`)) {
    throw new Error('Geçersiz oyun klasörü.');
  }
  const answer = await showMessage({ type: 'warning', title: 'Kaldırılsın mı?',
    detail: 'Kurulu oyun dosyaları silinecek. İndirilen ZIP korunacak.', buttons: ['Kaldır', 'Vazgeç'], defaultId: 1, cancelId: 1 }, game.name);
  if (answer.response !== 0) return false;
  await updateLibrary(async (current) => {
    if (playing.has(id)) throw new Error('Oyunu kaldırmadan önce kapat.');
    const index = current.findIndex((item) => item.id === id);
    if (index === -1) return;
    const info = await fsp.lstat(game.folder).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Geçersiz oyun klasörü.');
    const record = current[index];
    if ((record.playTimeMs ?? 0) > 0) {
      await saveSettings(({ restoredProgress: history }) => {
        const previous = history.find((entry) => matchesGame(entry, record, gamePage));
        return { restoredProgress: [
          ...history.filter((entry) => !matchesGame(entry, record, gamePage)),
          { ...previous, id: record.id, name: record.name, sourcePage: record.sourcePage,
            playTimeMs: Math.max(record.playTimeMs, previous?.playTimeMs ?? 0) }
        ] };
      });
    }
    await fsp.rm(game.folder, { recursive: true, force: true });
    const cover = coverPath(id);
    if (game.customCover && cover) await fsp.unlink(cover).catch((error) => {
      if (error.code !== 'ENOENT') console.error('Özel kapak silinemedi:', error.message);
    });
    current.splice(index, 1);
  });
  return true;
});
ipcMain.handle('settings:folders', () => folders);
ipcMain.handle('settings:get-theme', () => theme);
ipcMain.handle('settings:get-layout', () => libraryLayout);
ipcMain.handle('settings:get-card-fields', () => cardFields);
ipcMain.handle('settings:set-card-field', async (event, field, visible) => {
  if (event.sender !== mainWindow?.webContents ||
      !Object.hasOwn(defaultCardFields, field) || typeof visible !== 'boolean') return false;
  await saveSettings((settings) => ({ cardFields: { ...settings.cardFields, [field]: visible } }));
  return true;
});
ipcMain.handle('settings:set-layout', async (_event, value) => {
  if (!libraryLayouts.has(value)) throw new Error('Geçersiz kütüphane görünümü.');
  await saveSettings({ libraryLayout: value });
});
ipcMain.handle('settings:get-remember-login', () => rememberLogin);
ipcMain.handle('settings:set-remember-login', async (_event, value) => {
  if (typeof value !== 'boolean') throw new Error('Geçersiz oturum ayarı.');
  await saveSettings({ rememberLogin: value });
  await syncRememberedLogin();
});
ipcMain.handle('settings:set-theme', async (_event, value) => {
  if (!themes.has(value)) throw new Error('Geçersiz tema.');
  await saveSettings({ theme: value });
});
async function readProfileFile(filename, fallback) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeProfileFile(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(temporary, filename);
}

async function profileData(profile) {
  const root = profileRoot(profile);
  const defaults = await profileDefaults(root);
  if (profile.id === activeProfile?.id) {
    await Promise.all([pendingLibraryWrite, pendingCollectionWrite, pendingSettingsWrite]);
    return {
      active: true, defaults, games: await readLibrary(), collections,
      settings: { ...folders, theme, rememberLogin, keybindings, gamepadBindings, controlsEnabled, libraryLayout, restoredProgress, cardFields, gameAudio, fullscreenOnLaunch, metadataEnabled },
      updateGames: updateLibrary, updateCollections, saveSettings
    };
  }
  const library = path.join(root, 'library.json');
  const settings = path.join(root, 'settings.json');
  const collectionFile = path.join(root, 'collections.json');
  const data = {
    active: false, defaults,
    games: await readProfileFile(library, []),
    collections: await readProfileFile(collectionFile, []),
    settings: { ...defaults, ...await readProfileFile(settings, {}) },
    async updateGames(update) {
      await update(data.games);
      await writeProfileFile(library, data.games);
    },
    updateCollections: (update) => writeProfileFile(collectionFile, update(data.collections)),
    saveSettings: (changes) => writeProfileFile(settings, { ...data.settings, ...changes })
  };
  return data;
}

function withProfileData(action) {
  return async (event, id) => {
    const profile = profileRegistry.profiles.find((item) => item.id === id);
    if (!profile || event.sender !== mainWindow?.webContents) return false;
    if (profileDataBusy || profileSwitching) throw new Error('Bir profil işlemi zaten devam ediyor.');
    profileDataBusy = true;
    try { return await action(profile, await profileData(profile)); }
    finally { profileDataBusy = false; }
  };
}

ipcMain.handle('profiles:export', withProfileData(async (profile, data) => {
  const output = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), `DelFruit-${safeName(profile.name)}.json`),
    filters: [{ name: local('DelFruit profil yedeği'), extensions: ['json'] }]
  });
  if (output.canceled) return false;
  const installed = data.active ? await readLibrary() : data.games;
  const games = installed.map((game) => ({
    ...gameProgress(game),
    playTimeMs: (game.playTimeMs ?? 0) + (data.active ? elapsed(playing.get(game.id)) : 0)
  }));
  games.push(...(data.settings.restoredProgress ?? []).filter((record) =>
    !installed.some((game) => matchesGame(record, game, gamePage))));
  const { restoredProgress: _history, ...settings } = data.settings;
  const backup = { format: 'delfruit-profile', version: 1, profileName: profile.name,
    collections: data.collections, games, settings };
  await fsp.writeFile(output.filePath, JSON.stringify(backup, null, 2), 'utf8');
  return true;
}));

ipcMain.handle('profiles:import', withProfileData(async (profile, data) => {
  if (data.active) requireIdle();
  const input = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: local('DelFruit profil yedeği'), extensions: ['json'] }]
  });
  if (input.canceled) return false;
  const filename = input.filePaths[0];
  if ((await fsp.stat(filename)).size > 20 * 1024 * 1024) throw new Error('Yedek dosyası çok büyük.');
  let payload;
  try { payload = JSON.parse(await fsp.readFile(filename, 'utf8')); }
  catch { throw new Error('Yedek JSON dosyası okunamadı.'); }
  const backup = readBackup(payload);
  const answer = await showMessage({
    type: 'question', title: 'Profili içe aktar',
    detail: 'Eşleşen oyunların kişisel verileri, tema, oturum tercihi ve kullanılabilir klasör ayarları güncellenir. Kurulu oyun dosyaları korunur.',
    buttons: ['Vazgeç', 'İçe aktar'], defaultId: 0, cancelId: 0
  }, profile.name);
  if (answer.response !== 1) return false;
  if (data.active) requireIdle();
  const collectionIds = new Map();
  await data.updateCollections((current) => {
    const next = [...current];
    for (const entry of backup.collections) {
      const existing = next.find((item) => item.name.toLocaleLowerCase('tr') === entry.name.toLocaleLowerCase('tr'));
      if (existing) {
        collectionIds.set(entry.id, existing.id);
      } else {
        const id = next.some((item) => item.id === entry.id) ? crypto.randomUUID() : entry.id;
        next.push({ id, name: entry.name });
        collectionIds.set(entry.id, id);
      }
    }
    return next;
  });
  const imported = backup.games.map((record) => ({
    ...record, collectionIds: record.collectionIds.map((id) => collectionIds.get(id))
  }));
  const unmatched = new Set(imported);
  await data.updateGames((games) => {
    for (const game of games) {
      const record = imported.find((item) => matchesGame(item, game, gamePage));
      if (record) {
        applyProgress(game, record);
        unmatched.delete(record);
      }
    }
  });
  const settings = backup.settings;
  const changes = {
    restoredProgress: [...(data.settings.restoredProgress ?? []).filter((record) =>
      !imported.some((item) => matchesGame(item, record, gamePage))), ...unmatched]
  };
  if (themes.has(settings?.theme)) changes.theme = settings.theme;
  if (typeof settings?.rememberLogin === 'boolean') changes.rememberLogin = settings.rememberLogin;
  if (settings?.keybindings) {
    const bindings = normalizeBindings(settings.keybindings);
    if (new Set(Object.values(bindings)).size === Object.keys(controlDefaults).length) changes.keybindings = bindings;
  }
  if (settings?.gamepadBindings) {
    const bindings = normalizeGamepadBindings(settings.gamepadBindings);
    const buttons = Object.values(bindings).filter((button) => button !== null);
    if (new Set(buttons).size === buttons.length) changes.gamepadBindings = bindings;
  }
  if (typeof settings?.controlsEnabled === 'boolean') changes.controlsEnabled = settings.controlsEnabled;
  if (libraryLayouts.has(settings?.libraryLayout)) changes.libraryLayout = settings.libraryLayout;
  if (settings?.cardFields && typeof settings.cardFields === 'object') changes.cardFields = normalizeCardFields(settings.cardFields);
  if (settings?.gameAudio) changes.gameAudio = normalizeGameAudio(settings.gameAudio);
  if (typeof settings?.fullscreenOnLaunch === 'boolean') changes.fullscreenOnLaunch = settings.fullscreenOnLaunch;
  if (typeof settings?.metadataEnabled === 'boolean') changes.metadataEnabled = settings.metadataEnabled;
  for (const key of ['games', 'downloads']) {
    if (typeof settings?.[key] !== 'string' || !path.isAbsolute(settings[key])) continue;
    if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(settings[key])) continue;
    const directory = await fsp.stat(settings[key]).catch(() => null);
    if (directory?.isDirectory()) changes[key] = settings[key];
  }
  await data.saveSettings(changes);
  if (data.active) {
    await syncRememberedLogin().catch(() => {});
    libraryChanged();
  }
  return true;
}));
ipcMain.handle('profiles:reset-data', withProfileData(async (profile, data) => {
  const result = await showMessage({
    type: 'warning',
    title: 'Profilin verilerini sıfırla',
    detail: 'Koleksiyonlar, favoriler, tamamlandı işaretleri, sayaçlar, tema ve klasör tercihleri sıfırlanacak. Kurulu oyun dosyaları korunacak.',
    buttons: ['Vazgeç', 'Sıfırla'],
    defaultId: 0,
    cancelId: 0
  }, profile.name);
  if (result.response !== 1) return false;
  await data.updateCollections(() => []);
  await data.updateGames((games) => {
    const now = performance.now();
    for (const session of data.active ? playing.values() : []) {
      if (session.finishedMs !== undefined) session.finishedMs = 0;
      else if (session.started !== undefined) session.started = now;
    }
    for (const game of games) {
      delete game.collectionIds;
      delete game.favorite;
      delete game.completed;
      delete game.playTimeMs;
      delete game.launchCount;
      delete game.personalRating;
      delete game.gameMakerControls;
      delete game.audioConfig;
    }
  });
  await data.saveSettings(data.defaults);
  if (data.active) {
    await syncRememberedLogin().catch(() => {});
    libraryChanged();
  }
  return true;
}));
ipcMain.handle('settings:choose-folder', async (event, key) => {
  if (event.sender !== mainWindow?.webContents || !['downloads', 'games'].includes(key)) return null;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: local(key === 'downloads' ? 'ZIP indirme klasörünü seç' : 'Oyun kurulum klasörünü seç'),
    defaultPath: folders[key],
    properties: ['openDirectory', 'createDirectory']
  });
  if (selection.canceled) return null;
  const destination = await fsp.realpath(selection.filePaths[0]);
  const probe = await fsp.mkdtemp(path.join(destination, '.delfruit-'));
  await fsp.rmdir(probe);
  await saveSettings({ [key]: destination });
  return folders;
});
ipcMain.handle('library:show', async (_event, id) => {
  const game = (await readLibrary()).find((x) => x.id === id);
  if (game) shell.showItemInFolder(game.executable);
});
ipcMain.handle('app:site', () => SITE);
ipcMain.handle('app:version', () => app.getVersion().replace(/^(\d+\.\d+)\.0$/, '$1'));
ipcMain.handle('app:open-browser', (event, value) => {
  const url = webUrl(value);
  if (event.sender === mainWindow?.webContents && url) return shell.openExternal(url);
});
