/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      state.opened.push(url);
      return Promise.resolve();
    },
  },
}));

const { ACCOUNT_PORTAL_BASE_URL, resolveAccountPortalBaseUrl, buildSignInUrl, normalizeAccountProfile, signInWithBrowser } =
  await import('@process/services/accountLogin');

const portalIdentity = { id: 987, displayName: 'Test Person', provider: 'github' };

// 交换用的 fetch 会被 mock 掉，回调请求必须走真正的 fetch 才能打到本机监听端口。
// The exchange uses a mocked fetch, so callbacks must use the real one to reach the loopback listener.
const realFetch = globalThis.fetch;

const stubExchange = (status: number, body: unknown): ReturnType<typeof vi.fn> => {
  const exchange = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', exchange);
  return exchange;
};

/** 等应用把浏览器地址交出来 / Wait until the app hands the sign-in URL to the browser. */
const waitForSignInUrl = async (): Promise<URL> => {
  await vi.waitFor(() => {
    expect(state.opened.length).toBeGreaterThan(0);
  });
  return new URL(state.opened[state.opened.length - 1]);
};

beforeEach(() => {
  state.opened.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeAccountProfile', () => {
  it('keeps the identity the portal reports', () => {
    expect(normalizeAccountProfile(portalIdentity)).toEqual({
      portalId: '987',
      displayName: 'Test Person',
      provider: 'github',
    });
  });

  it('accepts string ids and trims text', () => {
    expect(normalizeAccountProfile({ id: '42', displayName: '  Alice  ' })).toEqual({
      portalId: '42',
      displayName: 'Alice',
      provider: '',
    });
  });

  it('rejects payloads that cannot identify a user', () => {
    expect(normalizeAccountProfile(null)).toBeNull();
    expect(normalizeAccountProfile('alice')).toBeNull();
    expect(normalizeAccountProfile({})).toBeNull();
    expect(normalizeAccountProfile({ id: '42' })).toBeNull();
    expect(normalizeAccountProfile({ id: '', displayName: 'Alice' })).toBeNull();
    expect(normalizeAccountProfile({ id: '42', displayName: '   ' })).toBeNull();
  });
});

describe('resolveAccountPortalBaseUrl', () => {
  it('defaults to the external test deployment', () => {
    expect(resolveAccountPortalBaseUrl({})).toBe('http://8.134.83.141:17000/agent-portal');
  });

  it('lets a local run point the portal at localhost', () => {
    expect(resolveAccountPortalBaseUrl({ AIONUI_ACCOUNT_PORTAL_URL: ' http://localhost:5173/ ' })).toBe(
      'http://localhost:5173'
    );
  });

  it('ignores a blank override', () => {
    expect(resolveAccountPortalBaseUrl({ AIONUI_ACCOUNT_PORTAL_URL: '   ' })).toBe(
      'http://8.134.83.141:17000/agent-portal'
    );
  });
});

describe('buildSignInUrl', () => {
  it('opens the portal itself and carries the loopback return with the state', () => {
    const url = new URL(buildSignInUrl('http://127.0.0.1:51022/aionui-auth', 'abc123'));
    const portal = new URL(ACCOUNT_PORTAL_BASE_URL);

    expect(url.origin).toBe(portal.origin);
    expect(url.pathname).toBe(`${portal.pathname}/`);
    expect(url.searchParams.get('client_return')).toBe('http://127.0.0.1:51022/aionui-auth');
    expect(url.searchParams.get('client_state')).toBe('abc123');
  });
});

describe('signInWithBrowser', () => {
  it('opens the portal in the browser and signs in only with the exchanged identity', async () => {
    const exchange = stubExchange(200, portalIdentity);

    const pending = signInWithBrowser();
    const entry = await waitForSignInUrl();
    const returnUrl = entry.searchParams.get('client_return');
    const clientState = entry.searchParams.get('client_state');
    expect(returnUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/aionui-auth$/);
    expect(clientState).toMatch(/^[0-9a-f]{32}$/);

    const callback = await realFetch(`${returnUrl}?state=${clientState}&code=one-time-code`);
    expect(callback.status).toBe(200);
    const page = await callback.text();
    expect(page).toContain('登录成功');
    // 一次性 code 不应留在地址栏 / The one-time code must not stay in the address bar.
    expect(page).toContain('history.replaceState');
    expect(page).toContain('/aionui-done');

    await expect(pending).resolves.toEqual({ portalId: '987', displayName: 'Test Person', provider: 'github' });
    expect(exchange).toHaveBeenCalledWith(
      `${ACCOUNT_PORTAL_BASE_URL}/api/auth/exchange`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'one-time-code' }) })
    );
  });

  it('rejects a callback whose state does not match', async () => {
    const exchange = stubExchange(200, portalIdentity);

    const pending = signInWithBrowser();
    const entry = await waitForSignInUrl();
    const returnUrl = entry.searchParams.get('client_return');

    const callback = await realFetch(`${returnUrl}?state=forged&code=one-time-code`);
    expect(callback.status).toBe(400);

    await expect(pending).resolves.toBeNull();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('stays signed out when the portal refuses the code', async () => {
    stubExchange(401, {});

    const pending = signInWithBrowser();
    const entry = await waitForSignInUrl();
    const returnUrl = entry.searchParams.get('client_return');
    const clientState = entry.searchParams.get('client_state');

    const callback = await realFetch(`${returnUrl}?state=${clientState}&code=replayed-code`);
    expect(callback.status).toBe(401);

    await expect(pending).resolves.toBeNull();
  });

  it('gives up when the user never comes back', async () => {
    stubExchange(200, portalIdentity);

    await expect(signInWithBrowser({ timeoutMs: 50 })).resolves.toBeNull();
  });
});
