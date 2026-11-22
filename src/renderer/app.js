const site = document.querySelector('#site');
const address = document.querySelector('#address');
const status = document.querySelector('#status');
const runningTimers = new Map();
let games = [];
let collections = [];
let sampledAt = performance.now();
const selectedTags = new Set();
const sortBy = document.querySelector('#sortBy');
const sortDirection = document.querySelector('#sortDirection');
const favoriteFilter = document.querySelector('#onlyFavorites');
const themePicker = document.querySelector('#theme');
const layoutPicker = document.querySelector('#libraryLayout');
let cardFields = {};
const cardFieldLabels = {
  thumbnail: 'Kapak görseli', rating: 'DelFruit puanı', ratingCount: 'Puan sayısı',
  difficulty: 'Average Difficulty', personalRating: 'Kişisel puan',
  tags: 'Etiketler', installedAt: 'Kurulum tarihi', playTime: 'Oynama süresi'
};
const { languages, translate } = window.launcherLocale;
let language = 'tr';
const t = (key) => translate(language, key);
const translatedError = (error) => t(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
const staticText = [];
const staticAttributes = [];
const isTranslated = (label) => Object.keys(languages).some((code) => translate(code, label) !== label);
const translations = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (translations.nextNode()) {
  const node = translations.currentNode;
  const label = node.nodeValue.trim();
  if (isTranslated(label)) staticText.push([node, node.nodeValue, label]);
}
for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
  for (const attr of ['aria-label', 'title', 'placeholder']) {
    const value = element.getAttribute(attr);
    if (value && isTranslated(value)) staticAttributes.push([element, attr, value]);
  }
}
const languagePicker = document.querySelector('#languagePicker');
const startupLanguage = document.querySelector('#startupLanguage');
const languageDialog = document.querySelector('#languageDialog');
for (const select of [languagePicker, startupLanguage]) {
  for (const [code, name] of Object.entries(languages)) select.add(new Option(name, code));
}

function applyLanguage(code) {
  language = code;
  document.documentElement.lang = code;
  languagePicker.value = code;
  for (const [node, original, label] of staticText) node.nodeValue = original.replace(label, t(label));
  for (const [element, attr, value] of staticAttributes) element.setAttribute(attr, t(value));
}

async function selectLanguage() {
  const saved = await window.launcher.getLanguage();
  if (saved) return saved;
  startupLanguage.value = Object.hasOwn(languages, navigator.language) ? navigator.language :
    Object.hasOwn(languages, navigator.language.split('-')[0]) ? navigator.language.split('-')[0] : 'tr';
  applyLanguage(startupLanguage.value);
  languageDialog.addEventListener('cancel', (event) => event.preventDefault());
  startupLanguage.onchange = () => applyLanguage(startupLanguage.value);
  languageDialog.showModal();
  return new Promise((resolve) => {
    document.querySelector('#languageForm').onsubmit = async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('button');
      submit.disabled = true;
      try {
        if (!await window.launcher.setLanguage(startupLanguage.value)) throw new Error(t('Dil seç'));
        languageDialog.close();
        resolve(startupLanguage.value);
      } catch (error) {
        document.querySelector('#languageStatus').textContent = translatedError(error);
        submit.disabled = false;
      }
    };
  });
}

languagePicker.onchange = async () => {
  const next = languagePicker.value;
  languagePicker.disabled = true;
  try {
    if (await window.launcher.setLanguage(next)) {
      applyLanguage(next);
      status.textContent = t('Hazır');
      if (controlState) renderControls();
      renderCardSettings();
      renderProfiles(await window.launcher.profiles());
      await refreshLibrary();
    }
  } catch (error) { alert(translatedError(error)); }
  finally { languagePicker.disabled = false; languagePicker.value = language; }
};

async function init() {
  applyLanguage(await selectLanguage());
  document.querySelector('#creditsVersion').textContent = `v${await window.launcher.version()}`;
  applyTheme(await window.launcher.getTheme());
  const profiles = await window.launcher.profiles();
  renderProfiles(profiles);
  if (!profiles.active) {
    showProfileDialog(profiles);
    return;
  }
  applyLayout(await window.launcher.getLayout());
  cardFields = await window.launcher.getCardFields();
  site.setAttribute('partition', profiles.partition);
  const home = await window.launcher.site();
  site.src = home;
  address.value = home;
  await refreshLibrary();
}

document.querySelectorAll('.nav button').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.nav button').forEach((item) => {
    item.classList.toggle('active', item === button);
    if (item === button) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((x) => x.classList.remove('active'));
  document.querySelector(`#${button.dataset.page}Page`).classList.add('active');
  if (['library', 'collections', 'stats'].includes(button.dataset.page)) void refreshLibrary();
  if (button.dataset.page === 'settings') void refreshSettings();
}));

const folderButtons = document.querySelectorAll('[data-folder]');
const settingsStatus = document.querySelector('#settings-status');
const creditsGithub = document.querySelector('#creditsGithub');
creditsGithub.addEventListener('click', (event) => {
  event.preventDefault();
  void window.launcher.openBrowser(creditsGithub.href).catch((error) => {
    settingsStatus.textContent = translatedError(error);
  });
});
const profilePicker = document.querySelector('#profilePicker');
const profileDialog = document.querySelector('#profileDialog');
const profileForm = document.querySelector('#profileForm');
const profileName = document.querySelector('#profileName');
const profileDialogStatus = document.querySelector('#profileDialogStatus');
const rememberCheckbox = document.querySelector('#rememberLogin');
let currentProfile;
let startupProfileRequired = false;

function renderProfiles(state) {
  currentProfile = state.active;
  profilePicker.replaceChildren(...state.profiles.map((profile) => new Option(profile.name, profile.id)));
  profilePicker.value = state.active ?? '';
  const footer = document.querySelector('#activeProfileName');
  const profile = state.profiles.find((item) => item.id === state.active);
  footer.hidden = !profile;
  footer.textContent = profile ? `● ${profile.name}` : '';
  const rows = document.querySelector('#profileDataRows');
  rows.replaceChildren(...state.profiles.map((entry) => {
    const row = document.createElement('div');
    row.className = 'profile-data-row';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    if (entry.id === state.active) name.title = t('Etkin profil');
    const actions = document.createElement('div');
    actions.className = 'backup-actions';
    for (const [action, label] of [['exportProfile', 'Profili dışa aktar'],
      ['importProfile', 'Profili içe aktar'], ['resetProfile', 'Profilin verilerini sıfırla']]) {
      const control = button(t(label), action === 'resetProfile' ? 'profile-reset' : '',
        () => profileAction(entry.id, action));
      control.setAttribute('aria-label', `${entry.name} — ${t(label)}`);
      actions.append(control);
    }
    row.append(name, actions);
    return row;
  }));
}

function showProfileDialog(state) {
  startupProfileRequired = !state.active;
  const cancel = document.querySelector('#cancelProfile');
  cancel.hidden = startupProfileRequired;
  const choices = document.querySelector('#startupProfiles');
  choices.replaceChildren();
  const chooseExisting = startupProfileRequired && state.profiles.length > 0;
  choices.hidden = !chooseExisting;
  profileForm.hidden = chooseExisting;
  if (chooseExisting) {
    const heading = document.createElement('h1');
    heading.textContent = t('Profil seç');
    choices.append(heading);
    for (const profile of state.profiles) {
      choices.append(button(profile.name, 'primary', () => window.launcher.selectProfile(profile.id)));
    }
  }
  profileName.value = '';
  profileDialogStatus.textContent = '';
  profileDialog.showModal();
}

profileDialog.addEventListener('cancel', (event) => {
  if (startupProfileRequired) event.preventDefault();
});
document.querySelector('#cancelProfile').onclick = () => profileDialog.close();
profileForm.onsubmit = async (event) => {
  event.preventDefault();
  const submit = profileForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try { await window.launcher.createProfile(profileName.value); }
  catch (error) {
    profileDialogStatus.textContent = translatedError(error);
    submit.disabled = false;
  }
};
document.querySelector('#newProfile').onclick = async () => showProfileDialog(await window.launcher.profiles());
document.querySelector('#activeProfileName').onclick = () => document.querySelector('[data-page="settings"]').click();
profilePicker.onchange = async () => {
  profilePicker.disabled = true;
  try { await window.launcher.selectProfile(profilePicker.value); }
  catch (error) { settingsStatus.textContent = translatedError(error); }
  finally {
    profilePicker.value = currentProfile;
    profilePicker.disabled = false;
  }
};

rememberCheckbox.onchange = async () => {
  rememberCheckbox.disabled = true;
  try { await window.launcher.setRememberLogin(rememberCheckbox.checked); }
  catch (error) { settingsStatus.textContent = translatedError(error); }
  finally {
    rememberCheckbox.checked = await window.launcher.getRememberLogin();
    rememberCheckbox.disabled = false;
  }
};

async function profileAction(id, action) {
  const buttons = document.querySelectorAll('#profileDataRows button');
  buttons.forEach((item) => { item.disabled = true; });
  settingsStatus.textContent = '';
  try {
    if (!await window.launcher[action](id)) return;
    if (id === currentProfile && action !== 'exportProfile') {
      if (action === 'resetProfile') {
        selectedTags.clear();
        favoriteFilter.setAttribute('aria-pressed', 'false');
        sortBy.value = 'added';
        sortDirection.value = 'desc';
      }
      applyTheme(await window.launcher.getTheme());
      applyLayout(await window.launcher.getLayout());
      await Promise.all([refreshSettings(), refreshLibrary()]);
    }
    const messages = {
      exportProfile: 'Profil yedeği kaydedildi.',
      importProfile: 'Yedek bu profile aktarıldı.',
      resetProfile: 'Profil verileri sıfırlandı.'
    };
    settingsStatus.textContent = t(messages[action]);
  } catch (error) {
    settingsStatus.textContent = translatedError(error);
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themePicker.value = theme;
}

themePicker.onchange = async () => {
  themePicker.disabled = true;
  try {
    await window.launcher.setTheme(themePicker.value);
    applyTheme(themePicker.value);
  } catch (error) {
    settingsStatus.textContent = error.message;
    applyTheme(await window.launcher.getTheme());
  } finally {
    themePicker.disabled = false;
  }
};

function applyLayout(value) {
  layoutPicker.value = value;
  document.querySelector('#games').dataset.layout = value;
}

layoutPicker.onchange = async () => {
  layoutPicker.disabled = true;
  try {
    await window.launcher.setLayout(layoutPicker.value);
    applyLayout(layoutPicker.value);
  } catch (error) {
    showToast([error.message]);
    applyLayout(await window.launcher.getLayout());
  } finally {
    layoutPicker.disabled = false;
  }
};

function showFolders(folders) {
  document.querySelector('#downloads-folder').textContent = folders.downloads;
  document.querySelector('#games-folder').textContent = folders.games;
}

async function refreshSettings() {
  try {
    showFolders(await window.launcher.getFolders());
    rememberCheckbox.checked = await window.launcher.getRememberLogin();
    controlState = await window.launcher.controls();
    controlsEnabled.checked = controlState.enabled;
    const options = await window.launcher.launchOptions();
    for (const [key, value] of Object.entries(options)) document.getElementById(key).checked = value;
    renderControls();
    showGameAudio(await window.launcher.gameAudio());
    cardFields = await window.launcher.getCardFields();
    renderCardSettings();
    renderCatalog();
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
}

for (const key of ['fullscreenOnLaunch', 'metadataEnabled']) {
  const checkbox = document.getElementById(key);
  checkbox.onchange = async () => {
    const checked = checkbox.checked;
    checkbox.disabled = true;
    try {
      if (!await window.launcher.setLaunchOption(key, checked)) checkbox.checked = !checked;
    } catch (error) {
      checkbox.checked = !checked;
      settingsStatus.textContent = translatedError(error);
    } finally {
      checkbox.disabled = false;
    }
  };
}

const gameAudioForm = document.querySelector('#gameAudioForm');
const gameAudioEnabled = document.querySelector('#gameAudioEnabled');
const gameMusic = document.querySelector('#gameMusic');
const gameSfx = document.querySelector('#gameSfx');
const gameAudioStatus = document.querySelector('#gameAudioStatus');

function showGameAudio(settings) {
  gameAudioEnabled.checked = settings.enabled;
  gameMusic.value = settings.music;
  gameSfx.value = settings.sfx;
  updateGameAudioLabels();
  updateGameAudioControls();
}

function updateGameAudioControls() {
  for (const slider of [gameMusic, gameSfx]) slider.disabled = !gameAudioEnabled.checked;
}

gameAudioEnabled.addEventListener('change', updateGameAudioControls);

function updateGameAudioLabels() {
  for (const slider of [gameMusic, gameSfx]) {
    document.querySelector(`#${slider.id}Value`).textContent =
      (Number(slider.value) / 100).toLocaleString(language, { style: 'percent' });
  }
}

for (const slider of [gameMusic, gameSfx]) slider.addEventListener('input', updateGameAudioLabels);
gameAudioForm.onsubmit = async (event) => {
  event.preventDefault();
  const save = gameAudioForm.querySelector('[type="submit"]');
  save.disabled = true;
  try {
    if (await window.launcher.saveGameAudio({
      enabled: gameAudioEnabled.checked, music: Number(gameMusic.value), sfx: Number(gameSfx.value)
    })) gameAudioStatus.textContent = t('Ses ayarları kaydedildi.');
  } catch (error) {
    gameAudioStatus.textContent = translatedError(error);
  } finally { save.disabled = false; }
};

function renderCardSettings() {
  const container = document.querySelector('#cardFields');
  container.replaceChildren(...Object.entries(cardFieldLabels).map(([field, text]) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = cardFields[field] !== false;
    checkbox.onchange = async () => {
      const checked = checkbox.checked;
      checkbox.disabled = true;
      try {
        if (!await window.launcher.setCardField(field, checked)) throw new Error(t('Ayar kaydedilemedi.'));
        cardFields[field] = checked;
        renderCatalog();
      } catch (error) {
        checkbox.checked = cardFields[field] !== false;
        settingsStatus.textContent = translatedError(error);
      } finally {
        checkbox.disabled = false;
      }
    };
    label.append(checkbox, t(text));
    return label;
  }));
}

let controlState;
const controlLabels = {
  left: 'Sol', right: 'Sağ', up: 'Yukarı', down: 'Aşağı',
  jump: 'Zıpla', shoot: 'Ateş et', restart: 'Yeniden başlat', skip: 'Atla', pause: 'Duraklat'
};
const controlsForm = document.querySelector('#controlsForm');
const controlsEnabled = document.querySelector('#controlsEnabled');
const controlStatus = document.querySelector('#controlStatus');

controlsEnabled.onchange = async () => {
  if (!controlState) return;
  const enabled = controlsEnabled.checked;
  controlsEnabled.disabled = true;
  try {
    if (!await window.launcher.setControlsEnabled(enabled)) throw new Error(t('Ayar kaydedilemedi.'));
    controlState.enabled = enabled;
  } catch (error) {
    controlsEnabled.checked = controlState.enabled;
    controlStatus.textContent = translatedError(error);
  } finally {
    controlsEnabled.disabled = false;
  }
};

function keyLabel(code) {
  const labels = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl'
  };
  return labels[code] ?? code.replace(/^(Key|Digit)/, '');
}

function renderControls() {
  window.gamepadNavigation.stopCapture();
  const container = document.querySelector('#controlBindings');
  container.replaceChildren();
  for (const [action, label] of Object.entries(controlLabels)) {
    const row = document.createElement('div');
    row.className = 'control-row';
    const title = document.createElement('span');
    title.textContent = t(label);
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'capture-key';
    key.setAttribute('aria-label', t(label));
    let listening = false;
    const update = () => { key.textContent = keyLabel(controlState.bindings[action]); };
    update();
    function stopListening() {
      listening = false;
      delete key.dataset.listening;
      update();
    }
    key.onclick = () => {
      listening = true;
      key.dataset.listening = '';
      key.textContent = t('Tuşa bas…');
    };
    key.onblur = stopListening;
    key.onkeydown = (event) => {
      if (!listening || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      if ((event.altKey && event.code !== 'AltLeft' && event.code !== 'AltRight') || event.metaKey) {
        controlStatus.textContent = t('Bu tuş desteklenmiyor.');
        return;
      }
      const code = /^[a-z]$/i.test(event.key) && /^Key[A-Z]$/.test(event.code)
        ? `Key${event.key.toUpperCase()}` : event.code;
      if (!/^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|(Shift|Control)(Left|Right)|F([1-9]|1[0-2])|Space|Enter|Backspace|Tab|Escape|Insert|Delete|Home|End|PageUp|PageDown|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(code)) {
        controlStatus.textContent = t('Bu tuş desteklenmiyor.');
        return;
      }
      controlState.bindings[action] = code;
      controlStatus.textContent = '';
      stopListening();
    };
    const reset = button(t('Sıfırla'), 'reset-key', () => {
      controlState.bindings[action] = controlState.defaults[action];
      controlState.gamepad[action] = null;
      update();
      updatePad();
    });
    reset.type = 'button';
    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'capture-pad';
    pad.setAttribute('aria-label', `${t('Gamepad')} · ${t(label)}`);
    const updatePad = () => {
      pad.textContent = window.gamepadNavigation.names[controlState.gamepad[action]] ?? t('Atanmamış');
    };
    pad.onclick = () => {
      pad.textContent = t('Gamepad düğmesine bas…');
      window.gamepadNavigation.capture((index) => {
        controlState.gamepad[action] = index;
        controlStatus.textContent = '';
        updatePad();
      });
    };
    pad.onblur = () => { window.gamepadNavigation.stopCapture(); updatePad(); };
    updatePad();
    row.append(title, key, pad, reset);
    container.append(row);
  }
}

document.querySelector('#resetControls').onclick = () => {
  if (!controlState) return;
  controlState.bindings = { ...controlState.defaults };
  controlState.gamepad = Object.fromEntries(Object.keys(controlState.defaults).map((action) => [action, null]));
  controlStatus.textContent = '';
  renderControls();
};
controlsForm.onsubmit = async (event) => {
  event.preventDefault();
  if (!controlState) return;
  const save = controlsForm.querySelector('[type="submit"]');
  save.disabled = true;
  try {
    if (await window.launcher.saveControls(controlState.bindings, controlState.gamepad)) controlStatus.textContent = t('Tuşlar kaydedildi.');
  } catch (error) {
    controlStatus.textContent = translatedError(error);
  } finally { save.disabled = false; }
};

folderButtons.forEach((button) => {
  button.onclick = async () => {
    folderButtons.forEach((item) => { item.disabled = true; });
    settingsStatus.textContent = '';
    try {
      const folders = await window.launcher.chooseFolder(button.dataset.folder);
      if (folders) {
        showFolders(folders);
        settingsStatus.textContent = t('Klasör kaydedildi.');
      }
    } catch {
      settingsStatus.textContent = t('Bu klasör kaydedilemedi. Yazma izni olan bir klasör seç.');
    } finally {
      folderButtons.forEach((item) => { item.disabled = false; });
    }
  };
});

function updateAddress(value) {
  let url;
  try { url = new URL(value); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol)) return;
  address.value = url.href;
  const isMediafire = url.hostname === 'mediafire.com' || url.hostname.endsWith('.mediafire.com');
  document.querySelector('#mediafireHelp').classList.toggle('hidden', !isMediafire);
}
site.addEventListener('did-navigate', (event) => updateAddress(event.url));
site.addEventListener('did-navigate-in-page', (event) => {
  if (event.isMainFrame) updateAddress(event.url);
});
site.addEventListener('did-start-navigation', (event) => {
  if (event.isMainFrame) updateAddress(event.url);
});
site.addEventListener('did-start-loading', () => { status.textContent = t('Yükleniyor…'); });
site.addEventListener('did-finish-load', () => { status.textContent = t('Hazır'); });
site.addEventListener('did-fail-load', (event) => {
  if (event.isMainFrame && event.errorCode !== -3) status.textContent = t('Sayfa yüklenemedi.');
});
document.querySelector('#external').onclick = async () => {
  try { await window.launcher.openBrowser(address.value); } catch (error) { alert(translatedError(error)); }
};
document.querySelector('#back').onclick = () => site.canGoBack() && site.goBack();
address.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  const value = address.value.trim();
  if (!value) return;
  let url;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
    url = new URL(hasScheme ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    status.textContent = t('Geçerli bir HTTP veya HTTPS adresi gir.');
    return;
  }
  address.blur();
  try {
    await site.loadURL(url.href);
  } catch (error) {
    if (error.code !== 'ERR_ABORTED') status.textContent = t('Sayfa yüklenemedi.');
  }
});
document.querySelector('#forward').onclick = () => site.canGoForward() && site.goForward();
document.querySelector('#reload').onclick = () => {
  site.reload();
};
document.querySelector('#refreshLibrary').onclick = refreshMetadata;
document.querySelector('#home').onclick = async () => site.loadURL(await window.launcher.site());
document.querySelector('#install').onclick = async () => { try { if (await window.launcher.installFile()) await refreshLibrary(); } catch (e) { alert(translatedError(e)); } };
document.querySelector('#importFolder').onclick = async (event) => {
  const control = event.currentTarget;
  control.disabled = true;
  try {
    const result = await window.launcher.importFolder();
    if (!result) return;
    await refreshLibrary();
    const messages = [t('{count} oyun eklendi.').replace('{count}', String(result.added))];
    if (result.skipped.length) {
      messages.push(t('Atlanan klasörler: {folders}').replace('{folders}', () =>
        result.skipped.slice(0, 4).join(', ') + (result.skipped.length > 4 ? '…' : '')));
    }
    showToast(messages);
  } catch (error) {
    showToast([translatedError(error)]);
  } finally {
    control.disabled = false;
  }
};
document.querySelector('#findMediafire').onclick = async () => {
  let downloadUrl;
  try {
    downloadUrl = await site.executeJavaScript(`(() => {
      if (location.hostname !== 'mediafire.com' && location.hostname !== 'www.mediafire.com') return null;
      return document.querySelector('a#downloadButton[href]')?.href ?? null;
    })()`);
  } catch {
    status.textContent = t('MediaFire sayfası okunamadı.');
    return;
  }
  let url;
  try { url = new URL(downloadUrl); } catch {
    status.textContent = t('MediaFire sayfasında indirme bağlantısı bulunamadı.');
    return;
  }
  if (url.protocol !== 'https:' || !/^download\d*\.mediafire\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || !/\.zip$/i.test(url.pathname)) {
    status.textContent = t('MediaFire düğmesinde geçerli bir ZIP bağlantısı bulunamadı.');
    return;
  }
  site.downloadURL(url.href);
};
document.querySelector('#importMediafire').onclick = async () => {
  try {
    if (await window.launcher.installFile()) document.querySelector('[data-page="library"]').click();
  } catch (error) { alert(error.message); }
};

async function refreshLibrary() {
  [games, collections] = await Promise.all([window.launcher.list(), window.launcher.listCollections()]);
  sampledAt = performance.now();
  renderTagFilters();
  renderCatalog();
}

function renderTagFilters() {
  const tags = [...new Set(games.flatMap((game) => game.metadata?.tags ?? []))]
    .sort((left, right) => left.localeCompare(right, 'tr'));
  for (const tag of selectedTags) {
    if (!tags.includes(tag)) selectedTags.delete(tag);
  }
  const options = document.querySelector('#tagFilters');
  options.replaceChildren();
  if (!tags.length) options.textContent = t('Etiket bulunamadı.');
  for (const tag of tags) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedTags.has(tag);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedTags.add(tag);
      else selectedTags.delete(tag);
      updateFilterCount();
      renderCatalog();
    };
    label.append(checkbox, tag);
    options.append(label);
  }
  updateFilterCount();
}

function updateFilterCount() {
  document.querySelector('#filterCount').textContent = selectedTags.size ? `(${selectedTags.size})` : '';
}

function sortValue(game, key) {
  switch (key) {
    case 'rating': return game.metadata?.rating ?? null;
    case 'personal': return game.personalRating ?? null;
    case 'count': return game.metadata?.ratingCount ?? null;
    case 'launches': return game.launchCount ?? 0;
    default: return Date.parse(game.installedAt) || 0;
  }
}

function visibleGames() {
  const favoritesOnly = favoriteFilter.getAttribute('aria-pressed') === 'true';
  const direction = sortDirection.value === 'asc' ? 1 : -1;
  return games.filter((game) => (!favoritesOnly || game.favorite) &&
    [...selectedTags].every((tag) => game.metadata?.tags?.includes(tag))).sort((left, right) => {
    const a = sortValue(left, sortBy.value);
    const b = sortValue(right, sortBy.value);
    if (a === null || b === null) {
      if (a !== b) return a === null ? 1 : -1;
    } else if (a !== b) {
      return direction * (a - b);
    }
    return left.name.localeCompare(right.name, 'tr');
  });
}

sortBy.onchange = sortDirection.onchange = renderCatalog;
favoriteFilter.onclick = () => {
  favoriteFilter.setAttribute('aria-pressed', String(favoriteFilter.getAttribute('aria-pressed') !== 'true'));
  renderCatalog();
};

function renderCatalog() {
  const focused = document.activeElement;
  const previous = focused.closest('.card[data-game-id]');
  const focusRole = focused.dataset.focusRole;
  const scope = previous?.closest('[data-collection], .page');
  const container = document.querySelector('#games');
  runningTimers.clear();
  const visible = visibleGames();
  container.replaceChildren(...visible.map(gameCard));
  const empty = document.querySelector('#empty');
  empty.classList.toggle('hidden', visible.length > 0);
  empty.querySelector('h2').textContent = t(games.length ? 'Eşleşen oyun yok' : 'Henüz oyun yok');
  empty.querySelector('p').hidden = games.length > 0;
  renderCollections();
  renderStats();
  if (previous && focusRole) {
    const targetScope = scope?.dataset.collection
      ? document.querySelector(`[data-collection="${CSS.escape(scope.dataset.collection)}"]`)
      : scope;
    const selector = `.card[data-game-id="${CSS.escape(previous.dataset.gameId)}"] [data-focus-role="${CSS.escape(focusRole)}"]`;
    const replacement = targetScope?.querySelector(selector);
    const fallback = document.querySelector('.page.active .card [data-focus-role="play"]') ??
      document.querySelector('.nav .active');
    (replacement && replacement.getClientRects().length ? replacement : fallback)?.focus({ preventScroll: true });
  }
}

function gameCard(game) {
    const card = document.createElement('article'); card.className = 'card';
    card.dataset.gameId = game.id;
    card.classList.toggle('completed-card', game.completed);
    if (cardFields.thumbnail !== false) card.append(gameCover(game));
    const title = document.createElement('h3'); title.textContent = game.name;
    card.append(title);
    if (game.metadata) {
      const count = `${t('Puan sayısı')}: ${game.metadata.ratingCount.toLocaleString(language)}`;
      if (cardFields.rating !== false) {
        card.append(ratingRow('DelFruit puanı', game.metadata.rating, cardFields.ratingCount === false ? '' : ` · ${count}`));
      } else if (cardFields.ratingCount !== false) {
        const votes = document.createElement('small');
        votes.textContent = count;
        card.append(votes);
      }
      if (cardFields.difficulty !== false && game.metadata.difficulty !== undefined) {
        card.append(ratingRow('Average Difficulty', game.metadata.difficulty, '', 100));
      }
    }
    if (cardFields.personalRating !== false && game.personalRating != null) {
      card.append(ratingRow('Kişisel puan', game.personalRating));
    }
    if (cardFields.tags !== false && game.metadata?.tags?.length) card.append(gameTags(game.metadata.tags));
    if (cardFields.installedAt !== false) {
      const date = document.createElement('small');
      date.textContent = `${t('Kuruldu')}: ${new Date(game.installedAt).toLocaleDateString(language)}`;
      card.append(date);
    }
    if (cardFields.playTime !== false) {
      const time = document.createElement('small');
      time.textContent = formatPlayTime(totalPlayTime(game));
      if (game.running) runningTimers.set(time, game);
      card.append(time);
    }
    card.append(gameActions(game));
    return card;
}

function gameCover(game) {
    const placeholder = document.createElement('img');
    placeholder.className = 'game-thumbnail thumbnail-placeholder';
    placeholder.alt = '';
    placeholder.loading = 'lazy';
    placeholder.src = 'assets/missing-thumbnail.png';
    placeholder.draggable = false;
    const screenshot = /^https:\/\/delicious-fruit\.sfo3\.digitaloceanspaces\.com\/(\d{1,12}_[0-9a-f]{8,14})$/
      .exec(game.metadata?.thumbnail ?? '')?.[1];
    const sources = [
      game.customCover ? `delfruit-cover://cover/${encodeURIComponent(game.id)}?v=${game.customCover}` : null,
      screenshot ? `delfruit-cover://screenshot/${screenshot}` : null
    ].filter(Boolean);
    if (sources.length) {
      const image = document.createElement('img');
      image.className = 'game-thumbnail';
      image.alt = t('{game} ekran görüntüsü').replace('{game}', () => game.name);
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        const next = sources.shift();
        if (next) image.src = next;
        else image.replaceWith(placeholder);
      });
      image.src = sources.shift();
      image.draggable = false;
      return image;
    }
    return placeholder;
}

function gameTags(tags) {
  const list = document.createElement('ul');
  list.className = 'game-tags';
  list.setAttribute('aria-label', t('Etiketler'));
  for (const tag of tags) {
    const item = document.createElement('li');
    item.textContent = tag;
    list.append(item);
  }
  return list;
}

function gameActions(game) {
    const completed = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = game.completed;
    checkbox.onchange = async () => {
      checkbox.disabled = true;
      try {
        await window.launcher.complete(game.id, checkbox.checked);
        await refreshLibrary();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        alert(translatedError(error));
      } finally {
        checkbox.disabled = false;
      }
    };
    completed.append(checkbox, ` ${t('Tamamlandı')}`);
    const actions = document.createElement('div'); actions.className = 'actions';
    const play = button(t(game.running ? 'Oyun açık' : 'Oyna'), 'play', async () => window.launcher.launch(game.id));
    play.disabled = game.running;
    play.dataset.focusRole = 'play';
    const folder = button(t('Klasör'), '', async () => window.launcher.show(game.id));
    const remove = button(t('Kaldır'), '', async () => { if (await window.launcher.remove(game.id)) refreshLibrary(); });
    const favorite = button(game.favorite ? '♥' : '♡', 'favorite-game', async () => {
      favorite.disabled = true;
      try {
        await window.launcher.favorite(game.id, !game.favorite);
        await refreshLibrary();
      } finally {
        favorite.disabled = false;
      }
    });
    favorite.setAttribute('aria-label', t(game.favorite ? 'Favoriden çıkar' : 'Favoriye ekle'));
    favorite.setAttribute('aria-pressed', String(!!game.favorite));
    favorite.dataset.focusRole = 'favorite';
    actions.append(play, favorite, gameOptions(game, completed, folder, remove));
    return actions;
}

function ratingRow(label, score, suffix = '', scale = 10) {
  const row = document.createElement('div');
  const difficulty = scale === 100;
  row.className = difficulty ? 'game-rating difficulty-rating' : 'game-rating';
  const heading = document.createElement('span');
  heading.className = 'rating-label';
  heading.textContent = t(label);
  row.append(heading);
  if (score == null) {
    row.append(t('Puan yok') + suffix);
    return row;
  }
  const stars = document.createElement('span');
  stars.className = 'rating-stars';
  stars.setAttribute('aria-hidden', 'true');
  stars.style.setProperty('--fill', `${100 * score / scale}%`);
  stars.textContent = difficulty ? '♥♥♥♥♥' : '★★★★★';
  row.append(stars, ` ${score.toLocaleString(language, { maximumFractionDigits: 1 })} / ${scale}${suffix}`);
  return row;
}

function gameOptions(game, completed, folder, remove) {
  const options = document.createElement('details');
  options.className = 'game-options';
  const trigger = document.createElement('summary');
  trigger.textContent = '⋮';
  trigger.dataset.focusRole = 'options';
  trigger.setAttribute('aria-label', t('{game} seçenekleri').replace('{game}', () => game.name));
  const panel = document.createElement('div');
  panel.className = 'game-options-panel';
  panel.append(completed, personalRatingControl(game),
    sourceControl(game), collectionControl(game), folder, remove);
  panel.insertBefore(button(t('Özel kapak seç'), '', () => window.launcher.customCover(game.id, false)), remove);
  if (game.customCover) {
    panel.insertBefore(button(t('Özel kapağı kaldır'), '', () => window.launcher.customCover(game.id, true)), remove);
  }
  const bindAudio = button(t('Ses ayarı dosyasını seç'), '', async () => {
    if (await window.launcher.chooseAudioConfig(game.id, false)) await refreshLibrary();
  });
  panel.insertBefore(bindAudio, remove);
  if (game.audioConfig) {
    panel.insertBefore(button(t('Ses dosyası bağlantısını kaldır'), '', async () => {
      if (await window.launcher.chooseAudioConfig(game.id, true)) await refreshLibrary();
    }), remove);
  }
  options.append(trigger, panel);
  return options;
}


function personalRatingControl(game) {
  const label = document.createElement('label');
  label.className = 'personal-rating';
  const picker = document.createElement('select');
  picker.add(new Option(t('Puan yok'), ''));
  for (let rating = 0; rating <= 10; rating++) picker.add(new Option(`${rating}/10`, String(rating)));
  picker.value = game.personalRating == null ? '' : String(game.personalRating);
  picker.onchange = async () => {
    picker.disabled = true;
    try {
      await window.launcher.personalRating(game.id, picker.value === '' ? null : Number(picker.value));
      await refreshLibrary();
    } catch (error) {
      picker.value = game.personalRating == null ? '' : String(game.personalRating);
      alert(translatedError(error));
      picker.disabled = false;
    }
  };
  label.append(t('Kişisel puan'), picker);
  return label;
}

document.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.virtual-select-menu')) return;
  document.querySelectorAll('.game-options[open]').forEach((options) => {
    if (!options.contains(event.target)) options.open = false;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const options = document.querySelector('.game-options[open]');
  if (options) {
    options.open = false;
    options.querySelector('summary').focus();
  }
});

async function refreshMetadata() {
  const label = document.querySelector('#libraryStatus');
  const refresh = document.querySelector('#refreshLibrary');
  refresh.disabled = true;
  label.textContent = t('DelFruit bilgileri güncelleniyor…');
  try {
    const { failedGames, disabled } = await window.launcher.refreshMetadata();
    await refreshLibrary();
    label.textContent = t("Kurulu fangame'ler");
    const messages = failedGames.slice(0, 3).map((name) =>
      t('{game} için veriler getirilemedi.').replace('{game}', () => name));
    if (failedGames.length > 3) messages.push(
      t('{count} oyun için daha veri alınamadı.').replace('{count}', String(failedGames.length - 3)));
    if (disabled) showToast([t('DelFruit oyun bilgisi alımı kapalı.')]);
    else if (messages.length) showToast(messages);
  } catch {
    label.textContent = t("Kurulu fangame'ler");
    showToast([t('DelFruit bilgileri alınamadı.')]);
  } finally {
    refresh.disabled = false;
  }
}

let toastTimer;
function showToast(messages) {
  const toast = document.querySelector('#toast');
  clearTimeout(toastTimer);
  toast.replaceChildren(...messages.map((message) => {
    const line = document.createElement('div');
    line.textContent = message;
    return line;
  }));
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

function sourceControl(game) {
  const source = document.createElement('div');
  source.className = 'game-source';
  if (game.sourcePage) {
    const link = document.createElement('a');
    link.href = game.sourcePage;
    link.textContent = t('DelFruit sayfası');
    link.onclick = (event) => {
      event.preventDefault();
      document.querySelector('[data-page="browser"]').click();
      site.loadURL(game.sourcePage).catch(() => {});
    };
    source.append(link);
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t(game.sourcePage ? 'Sayfayı değiştir' : 'DelFruit sayfası bağla');
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'url';
  input.required = true;
  input.placeholder = t('DelFruit oyun bağlantısı');
  input.setAttribute('aria-label', t('DelFruit oyun bağlantısı'));
  input.value = game.sourcePage ?? '';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = t('Kaydet');
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await window.launcher.setSource(game.id, input.value);
      await refreshLibrary();
    } catch (error) {
      alert(error.message);
      save.disabled = false;
    }
  };
  form.append(input, save);
  details.append(summary, form);
  source.append(details);
  return source;
}

function collectionControl(game) {
  const details = document.createElement('details');
  details.className = 'membership-options';
  if (!collections.length) {
    details.hidden = true;
    return details;
  }
  const summary = document.createElement('summary');
  summary.textContent = t('Koleksiyonlara ekle');
  details.append(summary);
  for (const collection of collections) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = (game.collectionIds ?? []).includes(collection.id);
    checkbox.onchange = async () => {
      checkbox.disabled = true;
      try {
        await window.launcher.setMembership(game.id, collection.id, checkbox.checked);
        await refreshLibrary();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        alert(error.message);
      } finally {
        checkbox.disabled = false;
      }
    };
    label.append(checkbox, collection.name);
    details.append(label);
  }
  return details;
}

document.querySelector('#createCollection').onsubmit = async (event) => {
  event.preventDefault();
  const input = document.querySelector('#collectionName');
  const status = document.querySelector('#collectionStatus');
  const submit = event.currentTarget.querySelector('button');
  submit.disabled = true;
  try {
    await window.launcher.createCollection(input.value);
    input.value = '';
    status.textContent = t('Oyun kartındaki ⋮ menüsünden koleksiyona oyun ekleyebilirsin.');
    await refreshLibrary();
  } catch (error) {
    status.textContent = translatedError(error);
  } finally {
    submit.disabled = false;
  }
};

function renderCollections() {
  const container = document.querySelector('#collections');
  const expanded = new Set([...container.querySelectorAll('details[data-collection][open]')]
    .map((element) => element.dataset.collection));
  container.replaceChildren();
  if (!collections.length) container.textContent = t('Henüz koleksiyon yok.');
  for (const collection of collections) {
    const members = games.filter((game) => (game.collectionIds ?? []).includes(collection.id));
    const group = document.createElement('details');
    group.className = 'collection-group';
    group.dataset.collection = collection.id;
    group.open = expanded.has(collection.id);
    const heading = document.createElement('summary');
    heading.textContent = `${collection.name} · ${t('Oyun')}: ${members.length.toLocaleString(language)}`;
    const contents = document.createElement('div');
    contents.className = 'games';
    if (members.length) contents.append(...members.map(gameCard));
    else contents.textContent = t('Bu koleksiyonda henüz oyun yok.');
    group.append(heading, contents);
    container.append(group);
  }
}

function totalPlayTime(game, now = performance.now()) {
  return (game.playTimeMs ?? 0) + (game.running ? now - sampledAt : 0);
}

function renderStats() {
  const now = performance.now();
  const summary = document.querySelector('#statsSummary');
  summary.replaceChildren();
  const total = games.reduce((sum, game) => sum + totalPlayTime(game, now), 0);
  for (const value of [
    `${t('Kurulu oyun')}: ${games.length.toLocaleString(language)}`,
    `${t('Tamamlanan oyun')}: ${games.filter((game) => game.completed).length.toLocaleString(language)}`,
    `${t('Toplam süre')}: ${formatDuration(total)}`
  ]) {
    const item = document.createElement('p');
    item.textContent = value;
    summary.append(item);
  }
  const ranking = document.querySelector('#playtimeRanking');
  const ranked = games.map((game) => ({ name: game.name, time: totalPlayTime(game, now) }))
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name, 'tr'));
  ranking.replaceChildren(...ranked.map(({ name, time }) => {
    const row = document.createElement('li');
    row.textContent = name;
    const duration = document.createElement('span');
    duration.textContent = formatDuration(time);
    row.append(duration);
    return row;
  }));
}

function formatPlayTime(milliseconds) {
  return `${t('Oynama süresi')}: ${formatDuration(milliseconds)}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((amount, position) => amount.toLocaleString(language, {
      style: 'unit', unit: ['hour', 'minute', 'second'][position], unitDisplay: 'short'
    })).join(' ');
}

setInterval(() => {
  const now = performance.now();
  for (const [element, game] of runningTimers) {
    element.textContent = formatPlayTime(totalPlayTime(game, now));
  }
  if (games.some((game) => game.running) && document.querySelector('#statsPage').classList.contains('active')) renderStats();
}, 500);

function button(text, className, action) {
  const value = document.createElement('button'); value.textContent = text; value.className = className;
  value.onclick = async () => { try { await action(); } catch (error) { alert(translatedError(error)); } };
  return value;
}

window.launcher.on('download-started', ({ name }) => {
  document.querySelector('#download').classList.remove('hidden'); document.querySelector('#downloadName').textContent = name; status.textContent = t('İndiriliyor');
});
window.launcher.on('download-progress', ({ received, total }) => {
  const percent = total > 0 ? Math.round(received / total * 100) : 0;
  document.querySelector('#downloadBar').value = percent; document.querySelector('#downloadPercent').textContent = `${percent}%`;
});
window.launcher.on('download-finished', ({ state }) => {
  status.textContent = t(state === 'completed' ? 'İndirme tamamlandı' : 'İndirme başarısız');
  setTimeout(() => document.querySelector('#download').classList.add('hidden'), 4000);
});
window.launcher.on('library-changed', refreshLibrary);
window.launcher.on('game-audio-unavailable', (name) => {
  showToast([t('{game} için ses ayarları uygulanamadı.').replace('{game}', () => name)]);
});
init();
