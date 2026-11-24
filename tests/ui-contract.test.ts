import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');

describe('Dashboard UI contract', () => {
  it('uses four simple top-level destinations', () => {
    const tabs = [...html.matchAll(/class="nav-tab[^"]*" data-tab="([^"]+)"/g)].map(
      (match) => match[1]
    );
    assert.deepEqual(tabs, ['home', 'studio', 'history', 'settings']);
    for (const id of [
      'tab-home',
      'tab-studio',
      'tab-history',
      'tab-settings',
      'tab-repos',
      'tab-rules',
      'tab-webhooks',
    ]) {
      assert.equal(html.includes(`id="${id}"`), true, `missing ${id}`);
    }
  });

  it('keeps existing review controls exactly once', () => {
    for (const id of [
      'btnRunReview',
      'textareaDiff',
      'selectProfile',
      'selectProvider',
      'annotatedDiffContainer',
      'globalChatInput',
      'btnDownloadReport',
    ]) {
      const count = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
      assert.equal(count, 1, `${id} appears ${count} times`);
    }
  });

  it('provides login, onboarding, jobs, and connection controls', () => {
    for (const id of [
      'loginForm',
      'loginToken',
      'btnTryDemo',
      'btnConnectProvider',
      'homeServerStatus',
      'homeAiStatus',
      'homeIntegrationsStatus',
      'jobsTableBody',
      'selectConnectionPlatform',
      'connectionWebhookUrl',
    ]) {
      assert.equal(html.includes(`id="${id}"`), true, `missing ${id}`);
    }
  });

  it('does not auto-run a review during initialization', () => {
    const initStart = js.indexOf('async function initApp');
    const initEnd = js.indexOf('function renderTemplatePills', initStart);
    assert.ok(initStart >= 0 && initEnd > initStart);
    const initBody = js.slice(initStart, initEnd);
    assert.doesNotMatch(initBody, /executeReview\s*\(/);
    assert.match(js, /btnTryDemo/);
  });

  it('ships local assets and strict Mermaid rendering', () => {
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/);
    assert.match(html, /\/vendor\/mermaid\.min\.js/);
    assert.match(js, /securityLevel:\s*'strict'/);
  });

  it('routes dashboard calls through authenticated apiFetch', () => {
    assert.match(js, /async function apiFetch/);
    assert.match(js, /window\['fetch'\]/);
    assert.match(js, /401/);
  });
});
