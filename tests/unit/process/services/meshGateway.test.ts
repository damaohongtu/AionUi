/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostMatches, startMeshGateway, type MeshGateway, type MeshGatewayTarget } from '@process/services/meshGateway';

type UpstreamRequest = {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
};

type Upstream = {
  target: MeshGatewayTarget;
  requests: UpstreamRequest[];
  close: () => Promise<void>;
};

const TOKEN = 'mesh-token-for-tests';

const startUpstream = async (
  respond: (request: UpstreamRequest) => { status?: number; headers?: Record<string, string>; body: string }
): Promise<Upstream> => {
  const requests: UpstreamRequest[] = [];
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    incoming.on('end', () => {
      const captured: UpstreamRequest = {
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body,
      };
      requests.push(captured);

      const reply = respond(captured);
      response.writeHead(reply.status ?? 200, reply.headers ?? { 'Content-Type': 'application/json' });
      response.end(reply.body);
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  return {
    target: { id: 'demo', name: 'Demo MCP', url: `http://127.0.0.1:${port}/mcp` },
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const cleanup: (() => Promise<void>)[] = [];

const startGateway = async (
  upstream: MeshGatewayTarget | null,
  overrides: Partial<Parameters<typeof startMeshGateway>[0]> = {}
): Promise<MeshGateway> => {
  const gateway = await startMeshGateway({
    port: 0,
    resolveTarget: (id) => Promise.resolve(upstream && id === upstream.id ? upstream : null),
    authValue: () => TOKEN,
    allowedHosts: ['127.0.0.1'],
    log: () => {},
    ...overrides,
  });
  cleanup.push(() => gateway.close());
  return gateway;
};

afterEach(async () => {
  const closes = cleanup.splice(0).map((close) => close());
  await Promise.all(closes);
});

describe('hostMatches', () => {
  it('matches exact hosts and wildcard suffixes', () => {
    expect(hostMatches('mesh.example.com', ['mesh.example.com'])).toBe(true);
    expect(hostMatches('MESH.Example.com', ['mesh.example.com'])).toBe(true);
    expect(hostMatches('api.mesh.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('mesh.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('evil-example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('mesh.example.com', [])).toBe(false);
  });
});

describe('mesh gateway forwarding', () => {
  it('injects the identity header, drops a client-supplied one and forwards the call', async () => {
    const upstream = await startUpstream((request) => ({
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' },
      body: JSON.stringify({ echoed: request.body }),
    }));
    cleanup.push(upstream.close);
    const gateway = await startGateway(upstream.target);

    const response = await fetch(`${gateway.baseUrl}/mcp/demo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-mesh-auth': 'forged-by-local-process',
        'Mcp-Session-Id': 'client-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBe('session-1');
    expect(await response.json()).toEqual({ echoed: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

    const received = upstream.requests[0];
    expect(received.headers['x-mesh-auth']).toBe(TOKEN);
    expect(received.headers['mcp-session-id']).toBe('client-session');
    expect(JSON.parse(received.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  it('does not send the identity to a host outside the allowlist', async () => {
    const upstream = await startUpstream(() => ({ body: '{}' }));
    cleanup.push(upstream.close);
    const gateway = await startGateway(upstream.target, { allowedHosts: ['mesh.example.com'] });

    await fetch(`${gateway.baseUrl}/mcp/demo`, { method: 'POST', body: '{}' });

    expect(upstream.requests[0].headers['x-mesh-auth']).toBeUndefined();
  });

  it('keeps the query string so SSE session ids survive', async () => {
    const upstream = await startUpstream(() => ({ body: '{}' }));
    cleanup.push(upstream.close);
    const gateway = await startGateway(upstream.target);

    await fetch(`${gateway.baseUrl}/mcp/demo?sessionId=abc&cursor=2`);

    expect(upstream.requests[0].url).toBe('/mcp?sessionId=abc&cursor=2');
  });

  it('passes event streams through untouched', async () => {
    const upstream = await startUpstream(() => ({
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'event: message\ndata: {"ok":true}\n\n',
    }));
    cleanup.push(upstream.close);
    const gateway = await startGateway(upstream.target);

    const response = await fetch(`${gateway.baseUrl}/mcp/demo`);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('data: {"ok":true}');
  });

  it('answers 404 for an unknown server', async () => {
    const gateway = await startGateway(null);

    const response = await fetch(`${gateway.baseUrl}/mcp/missing`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown MCP server' });
  });

  it('rejects oversized bodies', async () => {
    const upstream = await startUpstream(() => ({ body: '{}' }));
    cleanup.push(upstream.close);
    const gateway = await startGateway(upstream.target, { maxBodyBytes: 16 });

    const response = await fetch(`${gateway.baseUrl}/mcp/demo`, { method: 'POST', body: 'x'.repeat(64) });

    expect(response.status).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves status without ever exposing the identity value', async () => {
    const gateway = await startGateway({ id: 'demo', name: 'Demo MCP', url: 'http://127.0.0.1:1/mcp' });

    const response = await fetch(`${gateway.baseUrl}/status`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      running: true,
      port: gateway.port,
      baseUrl: gateway.baseUrl,
      auth: { configured: true },
      allowedHosts: ['127.0.0.1'],
    });
    expect(text).not.toContain(TOKEN);
  });

  it('refuses requests that are not addressed to loopback', async () => {
    const gateway = await startGateway(null);

    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: gateway.port,
          path: '/status',
          headers: { Host: 'evil.example.com' },
        },
        (response) => {
          let payload = '';
          response.on('data', (chunk: Buffer) => {
            payload += chunk.toString();
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: payload }));
        }
      );
      request.on('error', reject);
      request.end();
    });

    expect(status).toBe(403);
    expect(body).not.toContain(TOKEN);
  });

  it('moves to the next port when the preferred one is taken', async () => {
    const blocker: Server = createServer(() => {});
    const busyPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port));
    });
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    const gateway = await startGateway(null, { port: busyPort });

    expect(gateway.port).not.toBe(busyPort);
  });
});
