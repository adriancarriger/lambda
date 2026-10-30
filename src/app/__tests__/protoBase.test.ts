import { protoToken } from '../../mothership/protoToken';
import { PROTO_BASE, prototypeHeaders } from '../server/prototypes';

const connectSrc = (headers: Record<string, string>): string =>
  (headers['content-security-policy'] ?? '')
    .split('; ')
    .find((directive) => directive.startsWith('connect-src')) ?? '';

describe("a prototype's own folder, with its link token", () => {
  const token = protoToken(
    'secret',
    'dog-park',
    'desk',
    'v1',
    Date.UTC(2026, 9, 21)
  );
  const base = `/proto/${token}/dog-park/desk/v1/`;

  it('lets the prototype read its tokened folder back', () => {
    expect(PROTO_BASE.test(base)).toBe(true);
    expect(
      connectSrc(prototypeHeaders('/x/Desk.dc.html', 'localhost:4580', base))
    ).toBe(
      `connect-src http://localhost:4580${base} https://localhost:4580${base}`
    );
  });

  it('still takes a folder without a token, and nothing else', () => {
    expect(PROTO_BASE.test('/proto/dog-park/desk/v1/')).toBe(true);
    expect(PROTO_BASE.test('/proto/dog-park/desk/v1/x/')).toBe(false);
    expect(PROTO_BASE.test('/api/pod/dog-park/')).toBe(false);
    expect(
      connectSrc(prototypeHeaders('/x/Desk.dc.html', 'localhost:4580', '/api/'))
    ).toBe("connect-src 'none'");
  });
});
