import { proxiedOrigin } from '../devProxy';

const MOTHERSHIP = 'http://127.0.0.1:4580';

describe('the dev server’s proxy to the mothership', () => {
  it('presents its own page as the mothership’s origin', () => {
    expect(proxiedOrigin('http://localhost:4581', MOTHERSHIP)).toBe(MOTHERSHIP);
    expect(proxiedOrigin('http://127.0.0.1:4581', MOTHERSHIP)).toBe(MOTHERSHIP);
  });

  it('passes any other origin through, so the mothership refuses it', () => {
    expect(proxiedOrigin('http://localhost:3000', MOTHERSHIP)).toBe(
      'http://localhost:3000'
    );
    expect(proxiedOrigin('https://evil.example', MOTHERSHIP)).toBe(
      'https://evil.example'
    );
    expect(proxiedOrigin(undefined, MOTHERSHIP)).toBeUndefined();
  });
});
