import assert from 'node:assert/strict';
import { test } from 'node:test';

import { app } from '../server.mjs';

test('the home page answers', async () => {
  await new Promise((resolve) => app.listen(0, resolve));
  const { port } = app.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /It works/);
  } finally {
    app.close();
  }
});
