import { describe, it, expect } from 'vitest';
import { isLocalOrigin } from '../origin.js';

describe('isLocalOrigin', () => {
  it('accepts local dev origins on any port', () => {
    expect(isLocalOrigin('http://localhost:8081')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalOrigin('http://[::1]:5173')).toBe(true);
  });
  it('refuses look-alikes and garbage', () => {
    expect(isLocalOrigin('https://localhost.attacker.com')).toBe(false);
    expect(isLocalOrigin('https://notlocalhost.com')).toBe(false);
    expect(isLocalOrigin('localhost')).toBe(false);
  });
});
