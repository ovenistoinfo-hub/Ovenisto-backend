import { describe, it, expect } from 'vitest';
import { resolveEventRooms } from '../socket.js';

describe('resolveEventRooms', () => {
  it('two distinct outlets → both rooms + super-admin', () => {
    expect(resolveEventRooms(['o1', 'o2']).sort()).toEqual(
      ['outlet:o1', 'outlet:o2', 'super-admin'].sort()
    );
  });

  it('duplicate outlet ids → deduped to one room', () => {
    expect(resolveEventRooms(['o1', 'o1']).sort()).toEqual(
      ['outlet:o1', 'super-admin'].sort()
    );
  });

  it('a null id (central MAIN warehouse) → skipped, other side still targeted', () => {
    expect(resolveEventRooms([null, 'o2']).sort()).toEqual(
      ['outlet:o2', 'super-admin'].sort()
    );
  });

  it('undefined id → skipped', () => {
    expect(resolveEventRooms([undefined, 'o2']).sort()).toEqual(
      ['outlet:o2', 'super-admin'].sort()
    );
  });

  it('all-null ids → only super-admin', () => {
    expect(resolveEventRooms([null, null])).toEqual(['super-admin']);
  });

  it('empty list → only super-admin', () => {
    expect(resolveEventRooms([])).toEqual(['super-admin']);
  });
});
