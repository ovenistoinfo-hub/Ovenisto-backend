import { describe, it, expect } from 'vitest';
import { toVideoEmbedUrl } from '../site-content.helpers.js';

describe('toVideoEmbedUrl', () => {
  const yt = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

  it('reads every common YouTube link shape', () => {
    expect(toVideoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s')).toBe(yt);
    expect(toVideoEmbedUrl('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe(yt);
    expect(toVideoEmbedUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(yt);
    expect(toVideoEmbedUrl('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe(yt);
    expect(toVideoEmbedUrl(' https://www.youtube.com/embed/dQw4w9WgXcQ ')).toBe(yt);
  });

  it('reads Instagram posts and reels', () => {
    expect(toVideoEmbedUrl('https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=x')).toBe('https://www.instagram.com/reel/C1a2B3c4D5e/embed');
    expect(toVideoEmbedUrl('https://instagram.com/reels/C1a2B3c4D5e')).toBe('https://www.instagram.com/reel/C1a2B3c4D5e/embed');
    expect(toVideoEmbedUrl('https://www.instagram.com/p/C1a2B3c4D5e/')).toBe('https://www.instagram.com/p/C1a2B3c4D5e/embed');
  });

  it('refuses anything else', () => {
    expect(toVideoEmbedUrl(null)).toBeNull();
    expect(toVideoEmbedUrl('')).toBeNull();
    expect(toVideoEmbedUrl('not a url')).toBeNull();
    expect(toVideoEmbedUrl('https://evil.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(toVideoEmbedUrl('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(toVideoEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(toVideoEmbedUrl('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(toVideoEmbedUrl('https://www.youtube.com/channel/abc')).toBeNull();
    expect(toVideoEmbedUrl('https://www.instagram.com/someuser/')).toBeNull();
  });
});
