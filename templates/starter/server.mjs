import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);

/** Serves index.html for every path. */
export const app = createServer(async (_request, response) => {
  const html = await readFile(new URL('./index.html', import.meta.url));
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});

// Run as `node server.mjs` (not imported by a test). Real paths: a space is
// %20 in the URL, and a symlinked folder differs from the one it points at.
const runDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
