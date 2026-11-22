const PAGE_HOSTS = new Set(['delicious-fruit.com', 'www.delicious-fruit.com']);
const SCREENSHOT_ORIGIN = 'https://delicious-fruit.sfo3.digitaloceanspaces.com';

function screenshotKey(url) {
  return /^https:\/\/delicious-fruit\.sfo3\.digitaloceanspaces\.com\/(\d{1,12}_[0-9a-f]{8,14})$/.exec(url ?? '')?.[1];
}

function gamePage(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !PAGE_HOSTS.has(url.hostname) ||
      url.port || url.username || url.password) return null;
  const id = /^\/game\/(\d+)\/?$/.exec(url.pathname)?.[1] ??
    (url.pathname === '/ratings/game_details.php' ? url.searchParams.get('id') : null);
  return /^\d{1,12}$/.test(id ?? '') && Number(id) > 0
    ? `https://delicious-fruit.com/game/${Number(id)}`
    : null;
}

async function fetchGame(page, request) {
  const id = gamePage(page)?.split('/').pop();
  if (!id) throw new Error('Geçerli bir DelFruit oyun sayfası gir.');
  async function json(path) {
    const response = await request(`https://api.delicious-fruit.com${path}`, {
      signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store'
    });
    if (!response.ok) throw new Error(`DelFruit HTTP ${response.status}`);
    return response.json();
  }
  const [game, firstPage] = await Promise.all([
    json(`/composite/games/${id}/all`),
    json(`/games/${id}/reviews?includeOwnerReview=false&page=0&limit=100`)
  ]);
  if (String(game.id) !== id || game.removed) throw new Error('Oyun bulunamadı.');
  let count = 0;
  let reviews = firstPage;
  for (let pageNumber = 0; ; pageNumber++) {
    if (!Array.isArray(reviews)) throw new Error('DelFruit puan listesi okunamadı.');
    count += reviews.filter((review) => review.rating !== null && review.rating !== undefined &&
      Number.isFinite(Number(review.rating)) && Number(review.rating) >= 0 &&
      !review.removed && !review.owner_review).length;
    if (reviews.length < 100) break;
    reviews = await json(`/games/${id}/reviews?includeOwnerReview=false&page=${pageNumber + 1}&limit=100`);
  }
  const screenshot = game.screenshots?.find((image) => !image.removed && image.approved !== false);
  const screenshotId = Number(screenshot?.id);
  const rawRating = game.ratings?.rating ?? game.rating;
  const rating = rawRating == null ? NaN : Number(rawRating);
  const rawDifficulty = game.ratings?.difficulty ?? game.difficulty;
  const difficulty = rawDifficulty == null ? NaN : Number(rawDifficulty);
  return {
    tags: [...new Set((Array.isArray(game.tags) ? game.tags : [])
      .map((tag) => tag?.name)
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => name.trim()))],
    rating: Number.isFinite(rating) && rating >= 0 && rating <= 100 ? rating / 10 : null,
    difficulty: Number.isFinite(difficulty) && difficulty >= 0 && difficulty <= 100 ? difficulty : null,
    ratingCount: count,
    thumbnail: Number.isSafeInteger(screenshotId) && screenshotId > 0
      ? `${SCREENSHOT_ORIGIN}/${id}_${screenshotId.toString(16).padStart(8, '0')}`
      : null
  };
}

module.exports = { gamePage, fetchGame, screenshotKey };
