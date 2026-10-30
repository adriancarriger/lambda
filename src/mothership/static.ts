import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * The built client. Any path that isn't one of its files gets index.html, so
 * the app's own routes load; nothing here holds data.
 */
export const serveStatic = (
  clientDir: string,
  urlPath: string,
  response: http.ServerResponse
): void => {
  const root = path.resolve(clientDir);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  const target =
    file.startsWith(`${root}${path.sep}`) &&
    fs.existsSync(file) &&
    fs.statSync(file).isFile()
      ? file
      : path.join(root, 'index.html');

  if (!fs.existsSync(target)) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(
      'The Lambda app is not built. Run: pnpm --filter @adriancarriger/lambda build'
    );

    return;
  }

  response.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    // Only Lambda may frame its own pages (SameSite ignores ports, so a page
    // on another 127.0.0.1 port is "same-site"), and no type is guessed.
    'content-security-policy': "frame-ancestors 'self'",
    'x-content-type-options': 'nosniff',
    // index.html never cached, so a refresh never keeps an old build; the
    // hashed assets it names can be cached forever.
    'cache-control': target.endsWith('.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(target).pipe(response);
};
