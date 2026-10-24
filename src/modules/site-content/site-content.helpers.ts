/**
 * Pure helpers for the website's "Inside our kitchen" posts.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/;

/**
 * A pasted YouTube or Instagram link → the URL the website puts in its <iframe>, or null for
 * anything else (so the website never embeds an arbitrary page).
 */
export function toVideoEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean);

  let youtubeId: string | null = null;
  if (host === 'youtu.be') youtubeId = parts[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') youtubeId = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live'].includes(parts[0] ?? '')) youtubeId = parts[1] ?? null;
  }
  if (youtubeId) return YOUTUBE_ID.test(youtubeId) ? `https://www.youtube-nocookie.com/embed/${youtubeId}` : null;

  if (host === 'instagram.com') {
    const kind = parts[0] === 'reels' ? 'reel' : parts[0];
    const code = parts[1];
    if ((kind === 'p' || kind === 'reel' || kind === 'tv') && code && INSTAGRAM_CODE.test(code)) {
      return `https://www.instagram.com/${kind}/${code}/embed`;
    }
  }
  return null;
}
