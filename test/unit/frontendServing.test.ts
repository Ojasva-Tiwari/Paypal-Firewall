/**
 * PayGuard — Express Static Frontend Serving & SPA Fallback Tests (M4-T6)
 *
 * Verifies:
 * - Express serves index.html at root (GET /)
 * - Static assets are served correctly
 * - SPA routes (e.g. /overview, /payments) fallback to index.html
 * - SPA fallback never intercepts /api, /a, /mcp, or /healthz
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';

describe('Express Frontend Static Serving & SPA Fallback (M4-T6)', () => {
  let db: Database;
  let serverInstance: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;
  let tempStaticDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    // Create temporary static build directory with index.html and a dummy asset
    tempStaticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-web-'));
    fs.writeFileSync(
      path.join(tempStaticDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>PayGuard Test</title></head><body><div id="root">PayGuard App</div></body></html>',
      'utf8'
    );

    const assetsDir = path.join(tempStaticDir, 'assets');
    fs.mkdirSync(assetsDir);
    fs.writeFileSync(path.join(assetsDir, 'test.css'), 'body { background: #0D0F0D; }', 'utf8');

    serverInstance = createPayGuardMcpServer({
      db,
      staticDir: tempStaticDir,
    });

    const running = await serverInstance.start(0);
    serverPort = running.port;
    serverClose = running.close;
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
    try {
      fs.rmSync(tempStaticDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('serves index.html at root path GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('PayGuard App');
  });

  it('serves static assets from the assets directory', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/assets/test.css`);
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain('background: #0D0F0D');
  });

  it('falls back to index.html for SPA client-side routes like /overview and /payments', async () => {
    const resOverview = await fetch(`http://127.0.0.1:${serverPort}/overview`);
    expect(resOverview.status).toBe(200);
    const htmlOverview = await resOverview.text();
    expect(htmlOverview).toContain('PayGuard App');

    const resPayments = await fetch(`http://127.0.0.1:${serverPort}/payments`);
    expect(resPayments.status).toBe(200);
    const htmlPayments = await resPayments.text();
    expect(htmlPayments).toContain('PayGuard App');
  });

  it('strictly does NOT intercept public /healthz with SPA fallback', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/healthz`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; service: string };
    expect(json.status).toBe('ok');
    expect(json.service).toBe('payguard-mcp');
  });

  it('strictly does NOT intercept /api routes with SPA fallback', async () => {
    // GET /api/healthz should hit the owner API public health endpoint
    const resHealthz = await fetch(`http://127.0.0.1:${serverPort}/api/healthz`);
    expect(resHealthz.status).toBe(200);
    const jsonHealthz = (await resHealthz.json()) as { status: string; service: string };
    expect(jsonHealthz.service).toBe('payguard-owner-api');

    // GET /api/overview without session should return 401 JSON, NOT index.html
    const resOverview = await fetch(`http://127.0.0.1:${serverPort}/api/overview`);
    expect(resOverview.status).toBe(401);
    const jsonOverview = (await resOverview.json()) as { error: string };
    expect(jsonOverview.error).toBe('Authentication required');
  });

  it('strictly does NOT intercept /mcp with SPA fallback', async () => {
    // Unauthenticated GET /mcp should return 401 JSON, NOT index.html
    const res = await fetch(`http://127.0.0.1:${serverPort}/mcp`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(json.jsonrpc).toBe('2.0');
    expect(json.error.code).toBe(-32001);
  });
});
