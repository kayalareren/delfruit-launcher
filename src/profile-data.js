const path = require('node:path');

const PROFILE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function readBackup(value) {
  if (value?.format !== 'delfruit-profile' || value.version !== 1 ||
      !Array.isArray(value.games) || !Array.isArray(value.collections) ||
      value.games.length > 50000 || value.collections.length > 5000) {
    throw new Error('Geçerli bir DelFruit profil yedeği seç.');
  }
  const seen = new Set();
  const collections = value.collections.map((item) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!PROFILE_ID.test(item?.id ?? '') || !name || name.length > 60 || seen.has(item.id)) {
      throw new Error('Yedekte geçersiz bir koleksiyon var.');
    }
    seen.add(item.id);
    return { id: item.id, name };
  });
  const counter = (number) => Number.isSafeInteger(number) && number >= 0 ? number : 0;
  const games = value.games.map((item) => {
    if (!PROFILE_ID.test(item?.id ?? '') || typeof item.name !== 'string' || !item.name || item.name.length > 256) {
      throw new Error('Yedekte geçersiz bir oyun kaydı var.');
    }
    return {
      id: item.id, name: item.name, sourcePage: typeof item.sourcePage === 'string' ? item.sourcePage : null,
      favorite: item.favorite === true, completed: item.completed === true,
      personalRating: Number.isInteger(item.personalRating) && item.personalRating >= 0 &&
        item.personalRating <= 10 ? item.personalRating : null,
      playTimeMs: counter(item.playTimeMs), launchCount: counter(item.launchCount),
      collectionIds: [...new Set((Array.isArray(item.collectionIds) ? item.collectionIds : []).filter((id) => seen.has(id)))]
    };
  });
  return { collections, games, settings: value.settings ?? {} };
}

function matchesGame(record, game, normalizePage) {
  if (record.id === game.id) return true;
  const source = normalizePage(record.sourcePage);
  const currentSource = normalizePage(game.sourcePage);
  if (source && currentSource) return source === currentSource;
  const nameKey = (name) => name.normalize('NFKC').trim().toLowerCase().replace(/[_\s]+/g, ' ');
  return nameKey(record.name) === nameKey(game.name);
}

function gameProgress(game) {
  const { id, name, sourcePage, completed, favorite, personalRating, playTimeMs, launchCount, collectionIds } = game;
  return { id, name, sourcePage, completed, favorite, personalRating, playTimeMs, launchCount, collectionIds };
}

function installerFolders(buffer) {
  if (!buffer || buffer[0] !== 0xff || buffer[1] !== 0xfe) return {};
  const [downloads, games] = buffer.toString('utf16le', 2).split(/\r?\n/);
  return Object.fromEntries(Object.entries({ downloads, games })
    .filter(([, directory]) => typeof directory === 'string' && path.isAbsolute(directory)));
}

module.exports = { PROFILE_ID, readBackup, matchesGame, gameProgress, installerFolders };
