/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 网关的主进程启动入口 / Main-process bootstrap for the mesh gateway.
 *
 * P1 用环境变量提供身份，等门户开始签发 mesh token 后由 token 服务替换：
 * - `AIONUI_MESH_TOKEN`：注入到 `x-mesh-auth` 的值；
 * - `AIONUI_MESH_ALLOWED_HOSTS`：允许接收身份的主机，逗号分隔，支持 `*.example.com`；
 * - `AIONUI_MESH_GATEWAY_PORT`：首选端口，默认 39217。
 *
 * P1 takes the identity from the environment until the portal issues mesh tokens:
 * `AIONUI_MESH_TOKEN`, `AIONUI_MESH_ALLOWED_HOSTS`, `AIONUI_MESH_GATEWAY_PORT`.
 */

import { DEFAULT_MESH_GATEWAY_PORT, startMeshGateway, type MeshGateway } from './meshGateway';
import { resolveMeshGatewayTarget } from './meshGatewayTargets';

const TOKEN_ENV = 'AIONUI_MESH_TOKEN';
const HOSTS_ENV = 'AIONUI_MESH_ALLOWED_HOSTS';
const PORT_ENV = 'AIONUI_MESH_GATEWAY_PORT';

let starting: Promise<MeshGateway | null> | null = null;

const readPort = (): number => {
  const raw = process.env[PORT_ENV];
  if (!raw) return DEFAULT_MESH_GATEWAY_PORT;

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_MESH_GATEWAY_PORT;
};

const readAllowedHosts = (): string[] =>
  (process.env[HOSTS_ENV] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

const readToken = (): string | null => {
  const token = process.env[TOKEN_ENV]?.trim();
  return token ? token : null;
};

const log = (...args: unknown[]): void => console.warn(...args);

/**
 * 启动网关（幂等）。启动失败只记日志，不影响应用其余部分。
 * Start the gateway (idempotent). A failure only logs; the rest of the app is unaffected.
 */
export const startMeshGatewayFromEnv = (): Promise<MeshGateway | null> => {
  if (starting) return starting;

  starting = (async () => {
    try {
      const gateway = await startMeshGateway({
        port: readPort(),
        resolveTarget: resolveMeshGatewayTarget,
        authValue: readToken,
        allowedHosts: readAllowedHosts(),
        log,
      });
      const status = await gateway.status();
      log(
        `[AionUi] Mesh gateway: identity ${status.auth.configured ? 'configured' : 'not configured · set AIONUI_MESH_TOKEN'},` +
          ` allowed hosts ${status.allowedHosts.length > 0 ? status.allowedHosts.join(', ') : '(none)'}`
      );
      return gateway;
    } catch (error) {
      log('[AionUi] Mesh gateway failed to start:', error);
      return null;
    }
  })();

  return starting;
};
