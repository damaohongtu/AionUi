/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 本地 MCP 身份注入网关 / Local MCP identity gateway.
 *
 * 外部 MCP 客户端（例如本地 Claude Code）自己运行时，AionUi 无法拦截它们发往远端的请求。
 * 网关换个方向：客户端只连本机的 loopback 地址，由网关补上 `x-mesh-auth` 再转发到真实的
 * MCP 服务器，于是凭证只存在于 AionUi 进程里，不会写进客户端配置。
 *
 * External MCP clients (for example a local Claude Code) do not go through AionUi, so their
 * remote requests cannot be intercepted. The gateway flips the direction: clients connect to
 * a loopback address, the gateway adds `x-mesh-auth` and forwards to the real MCP server, so
 * the credential stays inside the AionUi process and never reaches client config files.
 *
 * P1 范围：http 转发、header 注入、固定端口、`/status`。SSE/流式按原样透传。
 * P1 scope: http forwarding, header injection, a fixed port and `/status`; streaming is
 * passed through untouched.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

/** 门户签发的身份头 / The portal-issued identity header. */
export const MESH_AUTH_HEADER = 'x-mesh-auth';
export const DEFAULT_MESH_GATEWAY_PORT = 39217;

const MCP_PREFIX = '/mcp/';
const STATUS_PATH = '/status';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PORT_ATTEMPTS = 20;

/** 逐跳头与禁止透传的头 / Hop-by-hop headers plus ones the gateway owns. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  MESH_AUTH_HEADER,
]);

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'www-authenticate', 'location'];

export type MeshGatewayTarget = {
  id: string;
  name: string;
  url: string;
};

export type MeshGatewayOptions = {
  /** 首选端口，占用时顺延 / Preferred port; the next free one is used when busy. */
  port?: number;
  /** 按路径里的 id 找到真实 MCP 服务器 / Resolve the real MCP server behind an id. */
  resolveTarget: (id: string) => Promise<MeshGatewayTarget | null>;
  /** 读取要注入的身份值，未登录时返回 null / Read the identity value, or null when signed out. */
  authValue: () => Promise<string | null> | string | null;
  /**
   * 允许接收身份的上游主机（支持 `*.example.com`）。为空时一律不注入。
   * Upstream hosts allowed to receive the identity (`*.example.com` supported). Empty disables it.
   */
  allowedHosts?: string[];
  maxBodyBytes?: number;
  log?: (...args: unknown[]) => void;
};

export type MeshGatewayStatus = {
  running: true;
  port: number;
  baseUrl: string;
  auth: { configured: boolean };
  allowedHosts: string[];
};

export type MeshGateway = {
  port: number;
  baseUrl: string;
  status: () => Promise<MeshGatewayStatus>;
  close: () => Promise<void>;
};

const normalizeHost = (host: string): string => host.trim().toLowerCase();

/** 主机是否在注入白名单里 / Whether the host may receive the identity. */
export const hostMatches = (host: string, patterns: string[]): boolean => {
  const target = normalizeHost(host);
  if (!target) return false;

  return patterns.some((raw) => {
    const pattern = normalizeHost(raw);
    if (!pattern) return false;
    if (pattern.startsWith('*.')) return target.endsWith(pattern.slice(1));
    return target === pattern;
  });
};

const isLoopbackHostHeader = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
};

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
};

class BodyTooLargeError extends Error {}

const readBody = (request: IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        reject(new BodyTooLargeError('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });

const forwardRequestHeaders = (incoming: IncomingHttpHeaders, token: string | null): Headers => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    if (!value || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  // 客户端自带的身份头一律丢弃，防止本机其他进程伪造 / Drop client-supplied identity to stop local spoofing.
  if (token) headers.set(MESH_AUTH_HEADER, token);

  return headers;
};

const writeDownstreamHeaders = (response: ServerResponse, upstream: Response): void => {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };

  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
};

export type StartMeshGatewayOptions = MeshGatewayOptions;

/**
 * 启动网关 / Start the gateway.
 *
 * 只监听 127.0.0.1；只代理 `resolveTarget` 认识的服务器；返回的 close 用于退出时释放端口。
 * Listens on 127.0.0.1 only, proxies only servers `resolveTarget` knows, and returns a close
 * hook so quitting releases the port.
 */
export const startMeshGateway = async (options: StartMeshGatewayOptions): Promise<MeshGateway> => {
  const log = options.log ?? ((...args: unknown[]) => console.warn(...args));
  const allowedHosts = (options.allowedHosts ?? []).filter((host) => host.trim().length > 0);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const preferredPort = options.port ?? DEFAULT_MESH_GATEWAY_PORT;

  const readAuthToken = async (): Promise<string | null> => {
    try {
      const value = await options.authValue();
      return typeof value === 'string' && value.trim() ? value : null;
    } catch {
      return null;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, port: number): Promise<void> => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      json(response, 403, { error: 'Forbidden host' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === STATUS_PATH) {
      const token = await readAuthToken();
      const status: MeshGatewayStatus = {
        running: true,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        auth: { configured: Boolean(token && token.trim()) },
        allowedHosts,
      };
      json(response, 200, status);
      return;
    }

    if (!url.pathname.startsWith(MCP_PREFIX) || request.method === undefined) {
      json(response, 404, { error: 'Not found' });
      return;
    }

    const targetId = decodeURIComponent(url.pathname.slice(MCP_PREFIX.length));
    let target: MeshGatewayTarget | null = null;
    try {
      target = targetId ? await options.resolveTarget(targetId) : null;
    } catch (error) {
      log('[AionUi] Mesh gateway could not resolve an MCP server:', error);
    }
    if (!target) {
      json(response, 404, { error: 'Unknown MCP server' });
      return;
    }

    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(target.url);
    } catch {
      json(response, 502, { error: 'Invalid MCP server address' });
      return;
    }
    if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
      json(response, 502, { error: 'Unsupported MCP server address' });
      return;
    }
    upstreamUrl.search = url.search;

    const token = hostMatches(upstreamUrl.hostname, allowedHosts) ? await readAuthToken() : null;

    let body: Buffer | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const declared = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        json(response, 413, { error: 'Request body too large' });
        request.resume();
        return;
      }
      try {
        body = await readBody(request, maxBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          json(response, 413, { error: 'Request body too large' });
          request.resume();
          return;
        }
        json(response, 400, { error: 'Could not read request body' });
        return;
      }
    }

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });

    try {
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardRequestHeaders(request.headers, token),
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: abort.signal,
      });
      clearTimeout(timeout);

      writeDownstreamHeaders(response, upstream);
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
    } catch (error) {
      clearTimeout(timeout);
      log('[AionUi] Mesh gateway could not reach an MCP server:', error);
      if (!response.headersSent) {
        json(response, 504, { error: 'MCP server did not respond' });
      } else {
        response.end();
      }
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response, (server.address() as AddressInfo | null)?.port ?? preferredPort);
  });

  const bind = (candidate: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, '127.0.0.1');
    });

  const bindFirstFreePort = async (attempt = 0): Promise<number> => {
    if (attempt >= MAX_PORT_ATTEMPTS) {
      throw new Error(`No free port between ${preferredPort} and ${preferredPort + MAX_PORT_ATTEMPTS - 1}`);
    }

    try {
      return await bind(preferredPort + attempt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return bindFirstFreePort(attempt + 1);
    }
  };

  const port = await bindFirstFreePort();

  const baseUrl = `http://127.0.0.1:${port}`;
  log(`[AionUi] Mesh gateway listening on ${baseUrl}`);

  return {
    port,
    baseUrl,
    status: async () => {
      const token = await readAuthToken();
      return {
        running: true,
        port,
        baseUrl,
        auth: { configured: Boolean(token && token.trim()) },
        allowedHosts,
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
