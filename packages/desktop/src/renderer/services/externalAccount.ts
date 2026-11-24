/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 外部账号（协作台）登录。
 *
 * 桌面端在应用内的登录窗口里完成登录，并且只在站点返回用户信息时才算成功；
 * WebUI 只能把登录页开在浏览器标签页里，切回应用时记为已登录（浏览器跨域，
 * 应用读不到站点的登录态）。
 *
 * External account (Agent Desk) sign-in.
 *
 * Desktop signs in through an app-owned window and only trusts the user payload
 * the portal itself returns. WebUI can only open the sign-in page in a browser
 * tab, so returning to the app marks the user signed in — the portal's session
 * is not readable across origins from the browser.
 */

import { ipcBridge } from '@/common';

/** 外部账号站点 / The external account portal. */
export const EXTERNAL_ACCOUNT_LOGIN_URL = 'http://8.134.83.141:17000/';

/** 登录完成后最少离开应用的时间，避免点击后立刻完成的误判 / Minimum time away from the app. */
const RETURN_GRACE_MS = 1200;

const SESSION_STORAGE_KEY = 'aionui.account.session';
const PENDING_STORAGE_KEY = 'aionui.account.login-pending';
const DEFAULT_ACCOUNT_NAME = 'account';
const MAX_ACCOUNT_NAME_LENGTH = 64;

/**
 * 桌面端一直以 `system_default_user` 归属本地数据（团队、会话等），
 * 外部账号只替换登录入口，不能改变数据归属，否则老数据会「消失」。
 *
 * The desktop build has always scoped local data (teams, sessions) to
 * `system_default_user`; the external account only replaces the sign-in entry
 * and must not change the owner, or existing data would seem to vanish.
 */
const LOCAL_ACCOUNT_ID = 'system_default_user';

export interface ExternalAccountSession {
  id: string;
  username: string;
  signedInAt: number;
  /** 站点里的用户标识 / The portal-side user id. */
  portalId?: string;
  /** 登录方式（例如 github）/ The sign-in provider reported by the portal. */
  provider?: string;
}

/** 站点确认过身份的账号 / An account the portal has confirmed. */
export interface VerifiedAccount {
  displayName: string;
  provider: string;
  portalId: string;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);
}

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 读取已保存的外部账号会话，格式不合法时返回 null / Read the stored session. */
export function readExternalAccountSession(): ExternalAccountSession | null {
  const storage = getLocalStorage();
  const raw = storage?.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const { id, username, signedInAt, portalId, provider } = parsed as Partial<ExternalAccountSession>;
    if (typeof id !== 'string' || !id) return null;
    if (typeof username !== 'string' || !username) return null;
    if (typeof signedInAt !== 'number' || !Number.isFinite(signedInAt)) return null;

    return {
      id,
      username,
      signedInAt,
      ...(typeof portalId === 'string' && portalId ? { portalId } : {}),
      ...(typeof provider === 'string' && provider ? { provider } : {}),
    };
  } catch {
    return null;
  }
}

/** 保存外部账号会话 / Persist a new external account session. */
export function saveExternalAccountSession(
  username: string,
  identity: { portalId?: string; provider?: string } = {}
): ExternalAccountSession {
  const session: ExternalAccountSession = {
    id: LOCAL_ACCOUNT_ID,
    username,
    signedInAt: Date.now(),
    ...(identity.portalId ? { portalId: identity.portalId } : {}),
    ...(identity.provider ? { provider: identity.provider } : {}),
  };

  getLocalStorage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

/** 清除外部账号会话 / Drop the stored session. */
export function clearExternalAccountSession(): void {
  getLocalStorage()?.removeItem(SESSION_STORAGE_KEY);
}

/** 记录一次登录跳转（仅 WebUI）/ Remember that a sign-in jump just happened (WebUI only). */
export function markExternalLoginPending(): void {
  getSessionStorage()?.setItem(PENDING_STORAGE_KEY, String(Date.now()));
}

/** 清除登录跳转记录 / Forget the pending sign-in jump. */
export function clearExternalLoginPending(): void {
  getSessionStorage()?.removeItem(PENDING_STORAGE_KEY);
}

/**
 * 是否已经离开足够久、可以判定为从登录页返回（仅 WebUI）。
 * Whether enough time has passed to treat the current focus as a return from the sign-in page (WebUI only).
 */
export function hasReturnedFromExternalLogin(): boolean {
  const raw = getSessionStorage()?.getItem(PENDING_STORAGE_KEY);
  if (!raw) return false;

  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt)) return false;

  return Date.now() - startedAt >= RETURN_GRACE_MS;
}

/**
 * 从登录页返回时 URL 上可能带账号名（?username= / ?account= / ?name=），仅 WebUI 使用。
 * The external page may hand the account name back on the URL (WebUI only).
 */
export function resolveReturnedAccountName(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return DEFAULT_ACCOUNT_NAME;
  }

  const named: Record<string, string> = {};
  for (const key of ['username', 'account', 'name']) {
    const value = params.get(key);
    if (value !== null) named[key] = value;
  }

  return resolveAccountNameFromParams(named);
}

/** 从参数里取账号名，取不到时用中性名字 / Pick an account name from params, neutral fallback. */
export function resolveAccountNameFromParams(params?: Record<string, string>): string {
  if (!params) return DEFAULT_ACCOUNT_NAME;

  const value = params.username ?? params.account ?? params.name;
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_ACCOUNT_NAME;

  return trimmed.slice(0, MAX_ACCOUNT_NAME_LENGTH);
}

/**
 * 打开登录入口。
 * Open the sign-in entry.
 *
 * - 桌面端：应用内登录窗口，站点确认用户后返回账号信息；用户取消时返回 null。
 * - WebUI：新标签页打开站点（弹窗被拦截时退回当前页跳转），返回 null，
 *   由调用方在用户切回应用时完成登录。
 *
 * - Desktop: app-owned login window; resolves with the portal-verified account,
 *   or null when the user cancels.
 * - WebUI: opens the portal in a tab (falls back to the current page); resolves
 *   null and the caller completes sign-in when the user comes back.
 */
export async function openExternalAccountLogin(): Promise<VerifiedAccount | null> {
  if (typeof window === 'undefined') return null;

  if (isDesktopRuntime()) {
    const profile = await ipcBridge.accountAuth.signIn.invoke();
    if (!profile) return null;

    return {
      displayName: profile.displayName,
      provider: profile.provider,
      portalId: profile.portalId,
    };
  }

  markExternalLoginPending();

  const popup = window.open(EXTERNAL_ACCOUNT_LOGIN_URL, '_blank');
  if (!popup) {
    // 弹窗被拦截：当前页跳转，返回时靠 sessionStorage 里的记录恢复登录态
    window.location.assign(EXTERNAL_ACCOUNT_LOGIN_URL);
    return null;
  }

  try {
    popup.opener = null;
  } catch {
    // 跨域页面不可写 opener；忽略
  }

  return null;
}
