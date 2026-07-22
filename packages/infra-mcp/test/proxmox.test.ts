import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxmoxApiError, ProxmoxClient } from '../src/drivers/proxmox/client.ts';
import { proxmoxDriver, setProxmoxFetch } from '../src/drivers/proxmox/index.ts';
import { SettingsStore } from '../src/settings.ts';
import type { DriverContext } from '../src/drivers/types.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  setProxmoxFetch(undefined);
});

function ctx(): DriverContext {
  const dir = mkdtempSync(join(tmpdir(), 'vo-pve-'));
  dirs.push(dir);
  const settings = new SettingsStore(join(dir, 'MCP_SETTINGS.json'));
  settings.save({
    connections: {
      homelab: {
        driver: 'proxmox',
        host: '192.168.1.8',
        user: 'root@pam',
        tokenId: 'mcp-server',
        tokenSecret: 'test-secret',
        tls: { rejectUnauthorized: false },
      },
    },
  });
  return { settings };
}

function jsonFetch(data: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('ProxmoxClient', () => {
  it('builds the API URL and PVEAPIToken auth header', async () => {
    const { fetchFn, calls } = jsonFetch([{ node: 'pve1', status: 'online' }]);
    const client = new ProxmoxClient(
      { driver: 'proxmox', host: '192.168.1.8', user: 'root@pam', tokenId: 'mcp-server' },
      'test-secret',
      fetchFn,
    );
    await client.request('/nodes');
    expect(calls[0]!.url).toBe('https://192.168.1.8:8006/api2/json/nodes');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'PVEAPIToken=root@pam!mcp-server=test-secret',
    );
  });

  it('classifies auth failures and node-name 596s with hints', async () => {
    const auth = new ProxmoxClient(
      { driver: 'proxmox', host: 'h' },
      's',
      jsonFetch({}, 401).fetchFn,
    );
    await expect(auth.request('/nodes')).rejects.toThrow(/Check the API token/);

    const badNode = new ProxmoxClient(
      { driver: 'proxmox', host: 'h' },
      's',
      jsonFetch({}, 596).fetchFn,
    );
    await expect(badNode.request('/nodes/wrong/status')).rejects.toThrow(/node name/);
  });
});

describe('proxmox driver tools', () => {
  it('vm_list uses cluster resources and returns structured guests', async () => {
    const guests = [
      { vmid: 100, name: 'web', node: 'pve1', status: 'running', type: 'qemu' },
      { vmid: 101, name: 'db', node: 'pve1', status: 'stopped', type: 'lxc' },
    ];
    setProxmoxFetch(jsonFetch(guests).fetchFn);
    const tools = proxmoxDriver.tools(ctx());
    const vmList = tools.find((t) => t.name === 'proxmox_vm_list')!;
    const result = await vmList.handler({ connection: 'homelab' });
    expect(result.data).toEqual(guests);
    expect(result.text).toContain('100 web [qemu] on pve1: running');
  });

  it('unknown connection produces a helpful error naming known connections', async () => {
    const tools = proxmoxDriver.tools(ctx());
    const nodes = tools.find((t) => t.name === 'proxmox_nodes')!;
    await expect(nodes.handler({ connection: 'nope' })).rejects.toThrow(
      /No connection named "nope".*homelab/s,
    );
  });

  it('tiers are assigned correctly across the tool surface', () => {
    const tools = proxmoxDriver.tools(ctx());
    const byTier = (tier: string) => tools.filter((t) => t.tier === tier).map((t) => t.name);
    expect(byTier('read')).toContain('proxmox_vm_list');
    expect(byTier('write')).toEqual(
      expect.arrayContaining(['proxmox_vm_start', 'proxmox_vm_create', 'proxmox_snapshot_create']),
    );
    expect(byTier('destructive')).toEqual(
      expect.arrayContaining(['proxmox_vm_delete', 'proxmox_snapshot_rollback']),
    );
    // Every destructive tool declares a confirm input.
    for (const t of tools.filter((t) => t.tier === 'destructive')) {
      expect(Object.keys(t.inputSchema)).toContain('confirm');
    }
  });

  it('probe reports reachable with version', async () => {
    setProxmoxFetch(jsonFetch({ version: '8.4.1', release: '8.4' }).fetchFn);
    const c = ctx();
    const probe = await proxmoxDriver.probe(c.settings.get().connections.homelab!, c);
    expect(probe).toEqual({ reachable: true, version: 'Proxmox VE 8.4.1' });
  });

  it('driver errors surface as ProxmoxApiError, not generic throws', async () => {
    setProxmoxFetch((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const tools = proxmoxDriver.tools(ctx());
    const nodes = tools.find((t) => t.name === 'proxmox_nodes')!;
    await expect(nodes.handler({ connection: 'homelab' })).rejects.toThrow(ProxmoxApiError);
  });
});
