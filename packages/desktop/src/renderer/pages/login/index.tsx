import loginLogo from '@renderer/assets/logos/brand/app.png';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/renderer/services/i18n';
import { useNavigate } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '../../hooks/context/AuthContext';
import { hasReturnedFromExternalLogin, isDesktopRuntime } from '@/renderer/services/externalAccount';
import './LoginPage.css';

const LoginPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status, startExternalAccountLogin, completeExternalAccountLogin } = useAuth();

  const [opening, setOpening] = useState(false);
  const [waitingForReturn, setWaitingForReturn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add('login-page-active');
    return () => {
      document.body.classList.remove('login-page-active');
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  // 仅 WebUI：桌面端在登录窗口里由站点确认用户，不需要「返回即登录」的推断。
  // WebUI only: desktop signs in through the login window and the portal's own
  // confirmation, so the "returning counts as signed in" guess is not used.

  // 1. 当前页跳转（弹窗被拦截）返回时，页面会重新加载，这里直接补完登录。
  useEffect(() => {
    if (isDesktopRuntime()) return;
    if (!hasReturnedFromExternalLogin()) return;

    const timer = window.setTimeout(() => {
      completeExternalAccountLogin();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [completeExternalAccountLogin]);

  // 2. 新标签页 / 系统浏览器登录后切回应用：focus、可见性或任意一次点击即视为返回。
  useEffect(() => {
    if (!waitingForReturn || isDesktopRuntime()) return;

    const handleReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!hasReturnedFromExternalLogin()) return;
      completeExternalAccountLogin();
    };

    window.addEventListener('focus', handleReturn);
    window.addEventListener('pointerdown', handleReturn);
    document.addEventListener('visibilitychange', handleReturn);
    return () => {
      window.removeEventListener('focus', handleReturn);
      window.removeEventListener('pointerdown', handleReturn);
      document.removeEventListener('visibilitychange', handleReturn);
    };
  }, [completeExternalAccountLogin, waitingForReturn]);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate('/guid', { replace: true });
    }
  }, [navigate, status]);

  const supportedLanguages = useMemo<{ code: string; label: string }[]>(
    () => [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'zh-TW', label: '繁體中文' },
      { code: 'ja-JP', label: '日本語' },
      { code: 'ko-KR', label: '한국어' },
      { code: 'tr-TR', label: 'Türkçe' },
      { code: 'uk-UA', label: 'Українська' },
      { code: 'pt-BR', label: 'Português (BR)' },
      { code: 'de-DE', label: 'Deutsch' },
      { code: 'es-ES', label: 'Español' },
      { code: 'fa-IR', label: 'فارسی' },
      { code: 'en-US', label: 'English' },
    ],
    []
  );

  const handleLanguageChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = event.target.value;
    changeLanguage(nextLanguage).catch((languageError: Error) => {
      console.error('Failed to change language:', languageError);
    });
  }, []);

  const handleAccountLogin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setOpening(true);
      // 登录在浏览器里进行，先把「回到应用」的提示亮出来。
      // Sign-in continues in the browser; show the "come back" hint right away.
      setWaitingForReturn(true);

      try {
        const signedIn = await startExternalAccountLogin();
        // 桌面端取消登录时什么都不做；WebUI 打开标签页后等待用户切回。
        // Desktop: a cancelled sign-in changes nothing. WebUI: wait for the user to come back.
        if (!signedIn) {
          setWaitingForReturn(isDesktopRuntime() ? false : true);
        }
      } catch (openError) {
        console.error('Failed to open the account sign-in page:', openError);
        setError(t('login.errors.networkError'));
      } finally {
        setOpening(false);
      }
    },
    [startExternalAccountLogin, t]
  );

  if (status === 'checking') {
    return <AppLoader />;
  }

  return (
    <div className='login-page'>
      <div className='login-page__card'>
        <label className='login-page__lang-select-wrapper' htmlFor='lang-select'>
          <select
            id='lang-select'
            className='login-page__lang-select'
            value={i18n.language}
            onChange={handleLanguageChange}
          >
            {supportedLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>

        <div className='login-page__header'>
          <div className='login-page__logo'>
            <img src={loginLogo} alt={t('login.brand')} />
          </div>
          <h1 className='login-page__title'>{t('login.brand')}</h1>
          <p className='login-page__subtitle'>{t('login.subtitle')}</p>
        </div>

        <form className='login-page__form' onSubmit={handleAccountLogin}>
          <button type='submit' className='login-page__submit' disabled={opening}>
            {opening && (
              <svg className='login-page__spinner' viewBox='0 0 24 24' width='18' height='18'>
                <circle
                  cx='12'
                  cy='12'
                  r='10'
                  stroke='currentColor'
                  strokeWidth='3'
                  fill='none'
                  strokeDasharray='50'
                  strokeDashoffset='25'
                  strokeLinecap='round'
                />
              </svg>
            )}
            <span>{opening ? t('login.submitting') : t('login.submit')}</span>
          </button>

          <div
            role='alert'
            aria-live='polite'
            className={`login-page__message ${error ? 'login-page__message--visible' : ''} ${error ? 'login-page__message--error' : ''}`}
            hidden={!error}
          >
            {error}
          </div>

          {waitingForReturn && <p className='login-page__return-hint'>{t('login.returnHint')}</p>}
        </form>

        <div className='login-page__footer'>
          <div className='login-page__footer-content'>
            <span>{t('login.footerPrimary')}</span>
            <span className='login-page__footer-divider'>•</span>
            <span>{t('login.footerSecondary')}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
