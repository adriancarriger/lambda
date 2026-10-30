import { MANIFEST_NAMESPACE, systemNamespace } from '../namespace';

describe('systemNamespace', () => {
  it.each([
    ['Pawnee parks map', 'PawneeParksMap'],
    ['3d viewer', 'App3dViewer'],
    ['Sweetums!', 'Sweetums'],
    ['react', 'AppReact'],
    ['math', 'AppMath'],
  ])('names a new design system for %j as %s', (name, expected) => {
    expect(systemNamespace(name)).toBe(expected);
    expect(systemNamespace(name)).toMatch(MANIFEST_NAMESPACE);
  });

  it("keeps the manifest's namespace whatever the project is called now", () => {
    expect(systemNamespace('Parks', 'Pawnee')).toBe('Pawnee');
  });

  it("keeps a manifest's namespace even when it names a browser global", () => {
    expect(systemNamespace('react', 'React')).toBe('React');
  });
});
