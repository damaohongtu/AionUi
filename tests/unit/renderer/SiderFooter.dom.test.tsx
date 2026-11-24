/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';
import { getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';

const renderFooter = (accountName?: string | null, collapsed = false): void => {
  render(
    <SiderFooter
      isMobile={false}
      isSettings={false}
      collapsed={collapsed}
      theme='light'
      siderTooltipProps={getSiderTooltipProps()}
      onSettingsClick={() => {}}
      onThemeToggle={() => {}}
      accountName={accountName}
    />
  );
};

describe('SiderFooter account name', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the signed-in account name', () => {
    renderFooter('damaohongtu');

    expect(screen.getByTestId('sider-account')).toHaveTextContent('damaohongtu');
  });

  it('keeps the name visible while the sider is collapsed', () => {
    renderFooter('damaohongtu', true);

    expect(screen.getByTestId('sider-account')).toHaveTextContent('damaohongtu');
  });

  it('renders no account row when signed out', () => {
    renderFooter(null);

    expect(screen.queryByTestId('sider-account')).toBeNull();
  });
});
