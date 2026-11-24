import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PREVIEW_SCOPE_KEY_PREFIX } from '@/renderer/pages/conversation/Preview/context/previewScope';
import { AUTH_REQUIRED_EVENT } from '@/common/config/constants';
import { refreshSession } from '@/common/adapter/sessionRefresh';
import {
  clearExternalAccountSession,
  clearExternalLoginPending,
  openExternalAccountLogin,
  readExternalAccountSession,
  resolveReturnedAccountName,
  saveExternalAccountSession,
  type ExternalAccountSession,
} from '@/renderer/services/externalAccount';
// M6: CSRF removed with legacy webserver — stub functions for compatibility, re-implement in M7
const withCsrfToken = <T extends Record<string, unknown>>(data: T): T => data;
const clearCookie = (_name: string, _path?: string): void => {};
const CSRF_COOKIE_NAME = 'csrf-token';

type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthUser {
  id: string;
  username: string;
}

interface AuthContextValue {
  ready: boolean;
  user: AuthUser | null;
  status: AuthStatus;
  /**
   * 打开外部账号登录。桌面端返回站点是否确认了用户；WebUI 打开标签页后返回 false，
   * 由 completeExternalAccountLogin 在用户切回应用时补完。
   *
   * Open the external account sign-in. Desktop reports whether the portal
   * confirmed a user; WebUI opens a tab and returns false, then
   * completeExternalAccountLogin finishes when the user comes back.
   */
  startExternalAccountLogin: () => Promise<boolean>;
  /** 从外部登录页返回后完成登录（WebUI）/ Finish sign-in after returning from the external page (WebUI). */
  completeExternalAccountLogin: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearAuthCache: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const AUTH_USER_ENDPOINT = '/api/auth/user';

const isDesktopRuntime = typeof window !== 'undefined' && Boolean(window.electronAPI);

// Clear expired auth cache including cookies and localStorage
// 清除过期的认证缓存，包括 Cookie 和 localStorage
function clearAuthCache(): void {
  if (typeof window === 'undefined') return;

  try {
    // Clear CSRF cookie
    clearCookie(CSRF_COOKIE_NAME);
    clearCookie(CSRF_COOKIE_NAME, '/');

    // Clear localStorage auth-related items, plus per-user UI state that must not
    // leak across accounts. Preview scopes are keyed by project id and hold file
    // content, so leaving them behind would show the next user the previous one's
    // open tabs — and nothing else ever cleaned them up.
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.includes('auth') ||
          key.includes('csrf') ||
          key.includes('token') ||
          key.startsWith(PREVIEW_SCOPE_KEY_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    console.error('Failed to clear auth cache:', error);
  }
}

async function fetchCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
  try {
    let response = await fetch(AUTH_USER_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
      signal,
    });

    // The access cookie may have expired — attempt one silent session refresh
    // and re-check before concluding the user is unauthenticated. Without this
    // the status poll would kick a refreshable session to /login (#4124).
    // refreshSession() single-flights with the httpBridge refresh path.
    if (response.status === 401) {
      const refreshed = await refreshSession();
      if (refreshed) {
        response = await fetch(AUTH_USER_ENDPOINT, {
          method: 'GET',
          credentials: 'include',
          signal,
        });
      }
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      success: boolean;
      user?: AuthUser;
    };
    if (data.success && data.user) {
      return data.user;
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return null;
    }
    console.error('Failed to fetch current user:', error);
  }

  return null;
}

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [ready, setReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const applyExternalSession = useCallback((session: ExternalAccountSession) => {
    setUser({ id: session.id, username: session.username });
    setStatus('authenticated');
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    // 外部账号登录态优先：它只在用户从登录页返回后才存在。
    // An external-account session wins: it only exists once the user came back
    // from the external sign-in page.
    const externalSession = readExternalAccountSession();
    if (externalSession) {
      applyExternalSession(externalSession);
      return;
    }

    // 桌面端与 WebUI 共用同一套登录入口，不再直接放行。
    // Desktop and WebUI share the same sign-in entry now; desktop is no longer
    // treated as implicitly authenticated.
    if (isDesktopRuntime) {
      setUser(null);
      setStatus('unauthenticated');
      setReady(true);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('checking');

    const currentUser = await fetchCurrentUser(controller.signal);
    if (currentUser) {
      setUser(currentUser);
      setStatus('authenticated');
    } else {
      setUser(null);
      setStatus('unauthenticated');
    }
    setReady(true);
  }, [applyExternalSession]);

  useEffect(() => {
    void refresh();
    return () => {
      abortRef.current?.abort();
    };
  }, [refresh]);

  // 实时通道确认登录失效时，清掉本地记录的外部账号登录态：
  // 本地标记还在的话，路由会把 /login 立刻弹回应用，和实时通道的踢回形成死循环。
  // Drop the locally recorded external account session when the realtime channel
  // confirms it is dead; otherwise the router bounces /login back into the app
  // while the realtime channel kicks the user out again — an endless loop.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleAuthRequired = () => {
      if (!readExternalAccountSession()) return;

      clearExternalAccountSession();
      clearExternalLoginPending();
      setUser(null);
      setStatus('unauthenticated');
      setReady(true);
    };

    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  const startExternalAccountLogin = useCallback(async () => {
    const account = await openExternalAccountLogin();
    // 桌面端：站点确认了用户才算登录；用户关掉登录窗口就是没登录。
    // Desktop: the portal has to confirm a user; closing the window is a cancel.
    if (!account) return false;

    clearExternalLoginPending();
    const session = saveExternalAccountSession(account.displayName, {
      portalId: account.portalId,
      provider: account.provider,
    });
    applyExternalSession(session);
    return true;
  }, [applyExternalSession]);

  const completeExternalAccountLogin = useCallback(() => {
    clearExternalLoginPending();
    const username = resolveReturnedAccountName(window.location.search);
    const session = saveExternalAccountSession(username);
    applyExternalSession(session);

    // Re-enable WebSocket reconnection after successful login (WebUI mode only)
    const reconnect = (window as { __websocketReconnect?: () => void }).__websocketReconnect;
    if (typeof reconnect === 'function') {
      reconnect();
    }
  }, [applyExternalSession]);

  const logout = useCallback(async () => {
    clearExternalAccountSession();
    clearExternalLoginPending();

    if (!isDesktopRuntime) {
      try {
        await fetch('/logout', {
          method: 'POST',
          // Logout also needs CSRF token / 登出同样需要 CSRF Token
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(withCsrfToken({})),
        });
      } catch (error) {
        console.error('Logout request failed:', error);
      }
    }

    setUser(null);
    setStatus('unauthenticated');
    setReady(true);
    // Clear cache on logout for security
    clearAuthCache();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user,
      status,
      startExternalAccountLogin,
      completeExternalAccountLogin,
      logout,
      refresh,
      clearAuthCache,
    }),
    [completeExternalAccountLogin, logout, ready, refresh, startExternalAccountLogin, status, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
