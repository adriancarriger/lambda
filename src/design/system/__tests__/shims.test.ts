import * as navigation from '../shims/navigation';
import Router, { useRouter } from '../shims/router';

/** The next/* stand-ins a design system's bundle gets instead of Next. */

describe('the next/navigation stand-in', () => {
  it('has the layout segment hooks, with no segments on a canvas', () => {
    expect(navigation.useSelectedLayoutSegment()).toBeNull();
    expect(navigation.useSelectedLayoutSegments()).toEqual([]);
  });
});

describe('the next/router stand-in', () => {
  it("navigates nowhere through the default export, as Next's singleton router does", async () => {
    const { push, replace } = Router;

    await expect(push('/parks/pawnee-commons')).resolves.toBe(true);
    await expect(replace('/parks')).resolves.toBe(true);
  });

  it('reports the root path, the same on every canvas', () => {
    expect(useRouter()).toMatchObject({
      pathname: '/',
      asPath: '/',
      route: '/',
    });
  });
});
