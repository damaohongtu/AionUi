/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 网关的 MCP 服务器解析 / MCP server resolution for the gateway.
 *
 * 网关只代理本机已经配置好的远程 MCP 服务器：id → transport.url。stdio 服务器没有 URL，
 * 也就没有 header 可加，直接不参与代理。结果短暂缓存，避免每个请求都打后端。
 *
 * The gateway proxies only remote MCP servers already configured on this machine (id →
 * transport.url). stdio servers have no URL and therefore no header to add, so they are not
 * proxied. Results are cached briefly so every proxied request does not hit the backend.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IMcpServer } from '@/common/config/storage';
import type { MeshGatewayTarget } from './meshGateway';

const CACHE_TTL_MS = 5_000;

let cache: { loadedAt: number; servers: IMcpServer[] } | null = null;
let inFlight: Promise<IMcpServer[]> | null = null;

const loadServers = async (): Promise<IMcpServer[]> => {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.servers;
  if (inFlight) return inFlight;

  inFlight = httpRequest<IMcpServer[]>('GET', '/api/mcp/servers')
    .then((servers) => {
      const list = Array.isArray(servers) ? servers : [];
      cache = { loadedAt: Date.now(), servers: list };
      return list;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

/** 仅测试使用：清空缓存 / Test hook: drop the cached catalog. */
export const resetMeshGatewayTargetCache = (): void => {
  cache = null;
  inFlight = null;
};

export const resolveMeshGatewayTarget = async (id: string): Promise<MeshGatewayTarget | null> => {
  const servers = await loadServers();
  const server = servers.find((candidate) => candidate.id === id);
  if (!server) return null;

  const { transport } = server;
  if (transport.type === 'stdio' || !transport.url) return null;

  return { id: server.id, name: server.name, url: transport.url };
};
