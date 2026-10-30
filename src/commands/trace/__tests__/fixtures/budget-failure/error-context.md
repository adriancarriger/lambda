# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: budget.spec.ts >> Pawnee budget page
- Location: budget.spec.ts:3:5

# Error details

```
TimeoutError: page.click: Timeout 1500ms exceeded.
Call log:
  - waiting for locator('#approve-budget')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
    - heading "Pawnee Parks Department" [level=1] [ref=e2]
    - paragraph [ref=e3]: Harvest Festival budget
```

# Test source

```ts
  1  | import { test } from '@playwright/test';
  2  |
  3  | test('Pawnee budget page', async ({ page }) => {
  4  |   await page.setContent(
  5  |     '<h1>Pawnee Parks Department</h1><p>Harvest Festival budget</p>' +
  6  |       '<script>console.error("Budget exceeded: Harvest Festival is over by $500")</script>'
  7  |   );
  8  |   await page.waitForTimeout(500);
> 9  |   await page.click('#approve-budget', { timeout: 1500 });
     |              ^ TimeoutError: page.click: Timeout 1500ms exceeded.
  10 | });
  11 |
```
