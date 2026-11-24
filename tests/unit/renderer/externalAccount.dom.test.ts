import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDesktopRuntime } from '@renderer/services/externalAccount';
import {
  EXTERNAL_ACCOUNT_LOGIN_URL,
  clearExternalAccountSession,
  clearExternalLoginPending,
  hasReturnedFromExternalLogin,
  markExternalLoginPending,
  openExternalAccountLogin,
  readExternalAccountSession,
  resolveAccountNameFromParams,
  resolveReturnedAccountName,
  saveExternalAccountSession,
} from '@/renderer/services/externalAccount';

const { signInInvoke } = vi.hoisted(() => ({ signInInvoke: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: {
    accountAuth: {
      signIn: { invoke: signInInvoke },
    },
  },
}));

const SESSION_KEY = 'aionui.account.session';
const PENDING_KEY = 'aionui.account.login-pending';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  signInInvoke.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('external account session', () => {
  it('returns null when nothing has been stored', () => {
    expect(readExternalAccountSession()).toBeNull();
  });

  it('round-trips a saved session', () => {
    const saved = saveExternalAccountSession('alice');

    expect(saved.username).toBe('alice');
    expect(readExternalAccountSession()).toEqual(saved);
    expect(localStorage.getItem(SESSION_KEY)).toContain('"alice"');
  });

  it('keeps the portal identity alongside the local owner id', () => {
    const saved = saveExternalAccountSession('Alice Chen', { portalId: '42', provider: 'github' });

    expect(saved.id).toBe('system_default_user');
    expect(saved.portalId).toBe('42');
    expect(saved.provider).toBe('github');
    expect(readExternalAccountSession()).toEqual(saved);
  });

  it('ignores malformed or incomplete stored data', () => {
    localStorage.setItem(SESSION_KEY, 'not-json');
    expect(readExternalAccountSession()).toBeNull();

    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: 'alice' }));
    expect(readExternalAccountSession()).toBeNull();
  });

  it('clears the stored session', () => {
    saveExternalAccountSession('alice');
    clearExternalAccountSession();
    expect(readExternalAccountSession()).toBeNull();
  });
});

describe('external login pending marker (WebUI)', () => {
  it('does not treat an immediate focus as a return', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
    markExternalLoginPending();

    vi.setSystemTime(new Date('2026-11-24T00:00:00.500Z'));
    expect(hasReturnedFromExternalLogin()).toBe(false);
  });

  it('treats a later return as signed in and can be cleared', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
    markExternalLoginPending();

    vi.setSystemTime(new Date('2026-11-24T00:00:02Z'));
    expect(hasReturnedFromExternalLogin()).toBe(true);

    clearExternalLoginPending();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(hasReturnedFromExternalLogin()).toBe(false);
  });

  it('ignores a corrupted marker', () => {
    sessionStorage.setItem(PENDING_KEY, 'not-a-number');
    expect(hasReturnedFromExternalLogin()).toBe(false);
  });
});

describe('resolveReturnedAccountName', () => {
  it('falls back to a neutral name', () => {
    expect(resolveReturnedAccountName('')).toBe('account');
    expect(resolveReturnedAccountName('?foo=bar')).toBe('account');
    expect(resolveReturnedAccountName('?username=%20%20')).toBe('account');
  });

  it('reads username / account / name from the return URL', () => {
    expect(resolveReturnedAccountName('?username=alice')).toBe('alice');
    expect(resolveReturnedAccountName('?account=bob')).toBe('bob');
    expect(resolveReturnedAccountName('?name=carol')).toBe('carol');
  });

  it('trims and truncates long names', () => {
    expect(resolveReturnedAccountName('?username=%20alice%20')).toBe('alice');
    expect(resolveReturnedAccountName(`?username=${'a'.repeat(200)}`)).toHaveLength(64);
  });
});

describe('resolveAccountNameFromParams', () => {
  it('reads the account name from params', () => {
    expect(resolveAccountNameFromParams({ username: 'alice' })).toBe('alice');
    expect(resolveAccountNameFromParams({ account: 'bob' })).toBe('bob');
    expect(resolveAccountNameFromParams({ name: 'carol' })).toBe('carol');
  });

  it('falls back to the neutral name for missing or blank params', () => {
    expect(resolveAccountNameFromParams()).toBe('account');
    expect(resolveAccountNameFromParams({})).toBe('account');
    expect(resolveAccountNameFromParams({ username: '   ' })).toBe('account');
  });
});

describe('openExternalAccountLogin', () => {
  // tests/vitest.dom.setup.ts installs a fake window.electronAPI; the external
  // account module keys the desktop path off it, so remove it for WebUI cases.
  const electronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;

  afterEach(() => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = electronAPI;
  });

  it('treats the desktop build as an Electron runtime', () => {
    expect(isDesktopRuntime()).toBe(true);
  });

  it('resolves the account the portal confirmed on desktop', async () => {
    signInInvoke.mockResolvedValue({ portalId: '42', displayName: 'Alice Chen', provider: 'github' });

    const account = await openExternalAccountLogin();

    expect(signInInvoke).toHaveBeenCalledTimes(1);
    expect(account).toEqual({ portalId: '42', displayName: 'Alice Chen', provider: 'github' });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('reports a cancelled sign-in instead of inventing a user', async () => {
    signInInvoke.mockResolvedValue(null);

    const account = await openExternalAccountLogin();

    expect(account).toBeNull();
    expect(readExternalAccountSession()).toBeNull();
  });

  it('opens the portal in a new tab in WebUI and marks a pending login', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const popup = { opener: {} as unknown };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    const account = await openExternalAccountLogin();

    expect(signInInvoke).not.toHaveBeenCalled();
    expect(account).toBeNull();
    expect(openSpy).toHaveBeenCalledWith(EXTERNAL_ACCOUNT_LOGIN_URL, '_blank');
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    expect(popup.opener).toBeNull();
  });
});
