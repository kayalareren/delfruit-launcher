const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function normalizeGameAudio(value) {
  const volume = (level) => Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : 100;
  return { enabled: value?.enabled === true, music: volume(value?.music), sfx: volume(value?.sfx) };
}

function updateAudioConfig(text, settings) {
  const audio = normalizeGameAudio(settings);
  const level = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  if (body.trimStart().startsWith('{')) {
    let config;
    try { config = JSON.parse(body); } catch { return null; }
    if (!level(config?.display?.bgm_volume) || !level(config?.display?.sfx_volume)) return null;
    if (config.display.bgm_volume === audio.music / 100 && config.display.sfx_volume === audio.sfx / 100) return text;
    config.display.bgm_volume = audio.music / 100;
    config.display.sfx_volume = audio.sfx / 100;
    const indent = body.includes('\n') ? 2 : 0;
    return bom + JSON.stringify(config, null, indent) + (body.endsWith('\r\n') ? '\r\n' : body.endsWith('\n') ? '\n' : '');
  }
  const lines = body.split(/(\r\n|\n)/);
  let section = '';
  const formats = new Map([
    ['volume', { music_volume: 'music', sound_volume: 'sfx' }],
    ['settings', { volume_level: 'music', sfx_level: 'sfx' }]
  ]);
  const entries = new Map();
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) section = header[1].toLowerCase();
    const entry = /^(\s*([a-z_]+)\s*=\s*)(\d+(?:[.,]\d*)?)(\s*(?:[;#].*)?)$/i.exec(line);
    const key = entry && formats.get(section)?.[entry[2].toLowerCase()];
    if (!key) continue;
    const value = Number(entry[3].replace(',', '.'));
    if (!level(value)) continue;
    if (!entries.has(section)) entries.set(section, new Map());
    const settings = entries.get(section);
    if (settings.has(key)) return null;
    settings.set(key, { index, entry, value });
  }
  const matches = [...entries.values()].filter((settings) => settings.size === 2);
  if (matches.length !== 1) return null;
  const configEntries = matches[0];
  const decimal = [...configEntries.values()].some(({ entry }) => entry[3].includes(',')) ? ',' : '.';
  for (const [key, { index, entry, value }] of configEntries) {
    const target = audio[key] / 100;
    if (target !== value) lines[index] = entry[1] + target.toFixed(2).replace('.', decimal) + entry[4];
  }
  return bom + lines.join('');
}

async function readAudioConfig(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.size > 1024 * 1024) return null;
  const data = await fs.readFile(filename);
  if (data.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { return null; }
}

function candidatesFor(game, env) {
  const gameDirectory = path.dirname(game.executable);
  const names = [...new Set([path.parse(game.executable).name, game.name])]
    .filter((name) => typeof name === 'string' && name && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/^[. ]+$/.test(name));
  const options = [
    [gameDirectory, 'Config.ini'],
    [gameDirectory, 'Data', 'Settings.cfg'],
    [gameDirectory, 'Settings.cfg']
  ];
  if (gameDirectory !== game.folder) options.push([game.folder, 'Config.ini'], [game.folder, 'Data', 'Settings.cfg']);
  for (const name of names) {
    if (env.LOCALAPPDATA) options.push([env.LOCALAPPDATA, name, 'Config.ini']);
    if (env.APPDATA) options.push([env.APPDATA, 'Godot', 'app_userdata', name, 'Data', 'Settings.cfg']);
  }
  return [...new Set(options.map((parts) => path.join(...parts)))];
}

async function applyGameAudio(game, settings, env = process.env) {
  const filenames = game.audioConfig ? [game.audioConfig] : candidatesFor(game, env);
  for (const filename of filenames) {
    let text;
    try {
      const actual = await fs.realpath(filename);
      if (path.resolve(actual).toLowerCase() !== path.resolve(filename).toLowerCase()) continue;
      text = await readAudioConfig(filename);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (text === null) continue;
    const updated = updateAudioConfig(text, settings);
    if (updated === null) continue;
    if (updated !== text) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx' });
      try { await fs.rename(temporary, filename); }
      catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    }
    return true;
  }
  return false;
}

module.exports = { normalizeGameAudio, updateAudioConfig, readAudioConfig, applyGameAudio };
