import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.locator('#loginToken').fill('ui-test-token');
  await page.locator('#loginForm').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('#homeServerStatus')).toHaveText('Healthy');
}

test('login rejects a bad token and accepts the admin token', async ({ page }) => {
  await page.goto('/');
  await page.locator('#loginToken').fill('wrong-token');
  await page.locator('#loginForm').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#loginStatus')).toContainText('Invalid admin token');
  await expect(page.locator('#loginScreen')).toBeVisible();

  await page.locator('#loginToken').fill('ui-test-token');
  await page.locator('#loginForm').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#homeServerStatus')).toHaveText('Healthy');
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(stored.local).toEqual([]);
  expect(stored.session).toEqual([]);
});

test('demo review starts only after an explicit click', async ({ page }) => {
  await login(page);
  await expect(page.locator('#viewPrTitle')).toHaveText('Loading PR Review...');

  await page.locator('#btnTryDemo').click();
  await expect(page.locator('#tab-studio')).toBeVisible();
  await expect(page.locator('#viewPrTitle')).not.toHaveText('Loading PR Review...');
  await expect(page.locator('#viewExecutiveSummary')).not.toBeEmpty();
  await expect(page.locator('#viewFileWalkthroughTable tr').first()).toBeVisible();
  await expect(page.locator('#kpiFindings')).toContainText('Finding');
  await expect(page.locator('#btnDownloadReport')).toBeEnabled();
});

test('connections guide explains Codeberg webhook setup', async ({ page }) => {
  await login(page);
  await page.locator('.nav-tab[data-tab="settings"]').click();
  await page.locator('[data-settings-target="webhooks"]').click();
  await page.locator('#selectConnectionPlatform').selectOption('forgejo');
  await expect(page.locator('#connectionWebhookUrl')).toHaveText(
    'https://review.example.com/api/webhooks/forgejo'
  );
  await expect(page.locator('#connectionGuide')).toContainText('Codeberg/Forgejo');
  await expect(page.locator('#connectionGuide')).toContainText('FORGEJO_TOKEN');
});

test('primary flows remain usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator('#btnTryDemo')).toBeVisible();
  await page.locator('#btnTryDemo').click();
  await expect(page.locator('#viewPrTitle')).not.toHaveText('Loading PR Review...');
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth + 1);
});
