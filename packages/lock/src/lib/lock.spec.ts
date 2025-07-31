import { lock } from './lock.js';

describe('lock', () => {
  it('should work', () => {
    expect(lock()).toEqual('lock');
  });
});
