/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 外部账号（协作台）登录。
 *
 * 登录在系统浏览器里完成：应用在本机回环地址上开一个临时端口，把浏览器指向门户的
 * 登录入口并带上回跳地址；用户在浏览器里登录后，门户把一次性 code 回跳到这个端口，
 * 应用再用 code 向门户换取用户信息。只有门户确认过的身份才算登录成功。
 *
 * Account sign-in for the external portal.
 *
 * Sign-in happens in the system browser: the app listens on a temporary loopback port and
 * points the browser at the portal's sign-in entry with a return address. Once the user is
 * signed in, the portal redirects back to that port with a single-use code, and the app
 * exchanges the code with the portal for the identity. Only a portal-confirmed identity
 * counts as signed in.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { shell } from 'electron';
import type { AccountProfile } from '@/common/adapter/ipcBridge';

/** 协作台站点基路径（共用域名下的统一前缀，不带结尾斜杠）/ The Agent Desk portal base URL, without a trailing slash. */
export const ACCOUNT_PORTAL_BASE_URL = 'http://8.134.83.141:17000/agent-portal';

const HANDSHAKE_PATH = '/aionui-auth';
const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 64;

type Logger = (...args: unknown[]) => void;

/** 把门户返回的用户数据收窄成可用的账号信息 / Narrow the portal payload into an account profile. */
export const normalizeAccountProfile = (raw: unknown): AccountProfile | null => {
  if (!raw || typeof raw !== 'object') return null;

  const { id, displayName, provider } = raw as Record<string, unknown>;
  const rawId = typeof id === 'number' && Number.isFinite(id) ? String(id) : id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;
  if (typeof displayName !== 'string' || !displayName.trim()) return null;

  return {
    portalId: rawId.trim().slice(0, 128),
    displayName: displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH),
    provider: typeof provider === 'string' ? provider.trim().slice(0, 32) : '',
  };
};

/**
 * 打开门户首页并带上本机回跳地址：用户在门户里点自己的「登录」完成登录，
 * 门户再把结果回跳给应用。不直接跳到上游身份提供方。
 *
 * Opens the portal itself with the loopback return address: the user signs in through the
 * portal's own entry and the portal hands the result back. No jump straight to the provider.
 */
export const buildSignInUrl = (returnUrl: string, state: string): string =>
  `${ACCOUNT_PORTAL_BASE_URL}/` +
  `?client_return=${encodeURIComponent(returnUrl)}&client_state=${encodeURIComponent(state)}`;

type SignInOptions = {
  timeoutMs?: number;
  log?: Logger;
};

let activeSignIn: Promise<AccountProfile | null> | null = null;

const DONE_PATH = '/aionui-done';

/** 纯文本进 HTML 前转义，避免门户返回的名字被当成标记执行 / Escape text so portal data can never become markup. */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const reply = (response: ServerResponse, status: number, title: string, detail: string, script = ''): void => {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6fa;color:#1f2430}main{text-align:center;padding:32px;border-radius:16px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#5b6270}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>${script ? `<script>${script}</script>` : ''}</body></html>`;

  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
};

const exchangeCode = async (code: string): Promise<AccountProfile | null> => {
  const response = await fetch(`${ACCOUNT_PORTAL_BASE_URL}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  return normalizeAccountProfile(await response.json());
};

/**
 * 在系统浏览器里完成外部账号登录。
 * Sign in to the external account through the system browser.
 *
 * @returns 门户确认的用户信息；用户放弃、超时或门户拒绝时是 null。
 *          The portal-confirmed profile, or null when cancelled, timed out or rejected.
 */
export const signInWithBrowser = (options: SignInOptions = {}): Promise<AccountProfile | null> => {
  const existing = activeSignIn;
  if (existing) return existing;

  const log: Logger = options.log ?? ((...args: unknown[]) => console.warn(...args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
  const state = randomBytes(16).toString('hex');
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let server: Server | null = null;

  const promise = new Promise<AccountProfile | null>((resolve) => {
    const finish = (profile: AccountProfile | null): void => {
      if (settled) return;
      settled = true;

      if (timer) clearTimeout(timer);
      timer = null;
      activeSignIn = null;
      server?.close();
      server = null;
      resolve(profile);
    };

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== HANDSHAKE_PATH) {
        reply(response, 404, 'AionUi', '未知的登录回调 / Unknown sign-in callback');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code || returnedState !== state) {
        log('[AionUi] Rejected an account sign-in callback with a mismatched state');
        reply(response, 400, '登录未完成 / Sign-in not completed', '回调校验失败，请回到 AionUi 重新登录。');
        finish(null);
        return;
      }

      let profile: AccountProfile | null = null;
      try {
        profile = await exchangeCode(code);
      } catch (error) {
        log('[AionUi] Failed to exchange the account sign-in code:', error);
      }

      if (!profile) {
        reply(response, 401, '登录未完成 / Sign-in not completed', '门户未能确认登录，请回到 AionUi 重新登录。');
        finish(null);
        return;
      }

      // 交接完成：把地址栏里的一次性 code 换成普通路径，页面刷新也不会泄露它。
      // Hand-off done: replace the one-time code in the address bar with a plain path.
      reply(
        response,
        200,
        '登录成功 / Signed in',
        `欢迎 ${profile.displayName}，可以关闭此页面并回到 AionUi。`,
        `history.replaceState(null, '', '${DONE_PATH}')`
      );
      finish(profile);
    };

    server = createServer((request, response) => {
      void handle(request, response);
    });

    server.on('error', (error: Error) => {
      log('[AionUi] Could not start the account sign-in listener:', error);
      finish(null);
    });

    server.listen(0, '127.0.0.1', () => {
      if (settled) return;

      const address = server?.address();
      if (!address || typeof address === 'string') {
        log('[AionUi] The account sign-in listener has no port');
        finish(null);
        return;
      }

      const returnUrl = `http://127.0.0.1:${address.port}${HANDSHAKE_PATH}`;
      timer = setTimeout(() => finish(null), timeoutMs);

      shell.openExternal(buildSignInUrl(returnUrl, state)).catch((error: unknown) => {
        log('[AionUi] Could not open the account sign-in page:', error);
        finish(null);
      });
    });
  });

  activeSignIn = promise;
  return promise;
};
