import { expect, test } from '@playwright/test';

const DOCS = 'http://127.0.0.1:8089';

test('documentation search finds provider guides', async ({ page }) => {
  await page.goto(`${DOCS}/index.html`);
  await expect(page.locator('h1')).toContainText('Code review');
  await page.getByRole('button', { name: 'Search documentation' }).click();
  await page.locator('.search-field input').fill('codeberg');
  await expect(page.locator('.search-result').first()).toContainText('Codeberg / Forgejo');
  await page.keyboard.press('Escape');
  await expect(page.locator('.search-modal')).not.toHaveClass(/open/);
});

test('documentation pages expose navigation, theme, and code copy', async ({ page }) => {
  await page.goto(`${DOCS}/getting-started.html`);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.toc-link').first()).toBeVisible();
  await expect(page.locator('.copy-button').first()).toBeVisible();
  await page.locator('[data-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('documentation navigation becomes a drawer on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${DOCS}/features.html`);
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Open documentation navigation' }).click();
  await expect(page.locator('body')).toHaveClass(/sidebar-open/);
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.locator('[data-sidebar-close]').first().click();
  await expect(page.locator('body')).not.toHaveClass(/sidebar-open/);
});
