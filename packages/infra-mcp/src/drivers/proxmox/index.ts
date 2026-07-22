import { z } from 'zod';
import type { DriverContext, InfraDriver, ToolModule, ToolResult } from '../types.js';
import type { ConnectionConfig } from '../../settings.js';
import { ProxmoxApiError, ProxmoxClient } from './client.js';

/** Injectable for tests. */
export let proxmoxFetch: typeof fetch | undefined;
export function setProxmoxFetch(f: typeof fetch | undefined): void {
  proxmoxFetch = f;
}

const connectionParam = {
  connection: z
    .string()
    .describe('Name of a configured connection from MCP_SETTINGS.json (e.g. "homelab")'),
};
const guestParams = {
  ...connectionParam,
  node: z.string().describe('Proxmox node name'),
  vmid: z.number().int().describe('Guest VMID'),
  type: z.enum(['qemu', 'lxc']).describe('Guest type: qemu VM or LXC container'),
};

function getClient(ctx: DriverContext, args: Record<string, unknown>): ProxmoxClient {
  const name = String(args.connection ?? '');
  const conn = ctx.settings.get().connections[name];
  if (!conn) {
    const known = Object.keys(ctx.settings.get().connections);
    throw new ProxmoxApiError(
      `No connection named "${name}" in MCP_SETTINGS.json.` +
        (known.length ? ` Known connections: ${known.join(', ')}.` : ' None are configured yet.'),
    );
  }
  if (conn.driver !== 'proxmox') {
    throw new ProxmoxApiError(`Connection "${name}" uses driver "${conn.driver}", not proxmox.`);
  }
  const secret = ctx.settings.resolveSecret(conn);
  if (!secret) {
    throw new ProxmoxApiError(
      `Connection "${name}" has no resolvable tokenSecret (check env-reference).`,
    );
  }
  return new ProxmoxClient(conn, secret, proxmoxFetch ?? fetch);
}

function ok(text: string, data?: unknown): ToolResult {
  return { text, data };
}

type Handler = (client: ProxmoxClient, args: Record<string, unknown>) => Promise<ToolResult>;

function tool(
  name: string,
  title: string,
  description: string,
  tier: ToolModule['tier'],
  inputSchema: Record<string, z.ZodType>,
  handler: Handler,
): (ctx: DriverContext) => ToolModule {
  return (ctx) => ({
    name,
    title,
    description,
    tier,
    inputSchema,
    // async so connection-resolution failures reject instead of throwing sync.
    handler: async (args) => handler(getClient(ctx, args), args),
  });
}

const guestPath = (a: Record<string, unknown>) => `/nodes/${a.node}/${a.type}/${a.vmid}`;

const TOOLS: Array<(ctx: DriverContext) => ToolModule> = [
  // ---- read tier ----
  tool(
    'proxmox_nodes',
    'List nodes',
    'List all nodes in the Proxmox cluster with status and resource usage.',
    'read',
    connectionParam,
    async (c) => {
      const nodes = await c.request<Array<{ node: string; status: string }>>('/nodes');
      return ok(
        `${nodes.length} node(s): ${nodes.map((n) => `${n.node} (${n.status})`).join(', ')}`,
        nodes,
      );
    },
  ),
  tool(
    'proxmox_node_status',
    'Node status',
    'Detailed status of one node: CPU, memory, uptime, kernel.',
    'read',
    { ...connectionParam, node: z.string() },
    async (c, a) => {
      const status = await c.request(`/nodes/${a.node}/status`);
      return ok(`Status for node ${a.node}`, status);
    },
  ),
  tool(
    'proxmox_vm_list',
    'List guests',
    'List all VMs and LXC containers across the cluster (name, vmid, node, status, type).',
    'read',
    connectionParam,
    async (c) => {
      const guests = await c.request<
        Array<{ vmid: number; name?: string; node: string; status: string; type: string }>
      >('/cluster/resources?type=vm');
      const lines = guests
        .map((g) => `${g.vmid} ${g.name ?? '(unnamed)'} [${g.type}] on ${g.node}: ${g.status}`)
        .join('\n');
      return ok(`${guests.length} guest(s):\n${lines}`, guests);
    },
  ),
  tool(
    'proxmox_vm_status',
    'Guest status',
    'Current status of one VM or container (state, cpu, mem, uptime).',
    'read',
    guestParams,
    async (c, a) => ok(`Status for ${a.type} ${a.vmid}`, await c.request(`${guestPath(a)}/status/current`)),
  ),
  tool(
    'proxmox_storage_list',
    'List storage',
    'List storage pools on a node with usage and content types.',
    'read',
    { ...connectionParam, node: z.string() },
    async (c, a) => {
      const storage = await c.request<Array<{ storage: string; type: string }>>(
        `/nodes/${a.node}/storage`,
      );
      return ok(`${storage.length} storage pool(s) on ${a.node}`, storage);
    },
  ),
  tool(
    'proxmox_snapshot_list',
    'List snapshots',
    'List snapshots of a VM or container.',
    'read',
    guestParams,
    async (c, a) => {
      const snaps = await c.request<Array<{ name: string }>>(`${guestPath(a)}/snapshot`);
      return ok(`${snaps.length} snapshot(s) for ${a.type} ${a.vmid}`, snaps);
    },
  ),
  tool(
    'proxmox_backup_list',
    'List backups',
    'List backup volumes on a storage.',
    'read',
    { ...connectionParam, node: z.string(), storage: z.string() },
    async (c, a) => {
      const backups = await c.request<Array<{ volid: string }>>(
        `/nodes/${a.node}/storage/${a.storage}/content?content=backup`,
      );
      return ok(`${backups.length} backup(s) on ${a.storage}`, backups);
    },
  ),
  tool(
    'proxmox_next_vmid',
    'Next free VMID',
    'Get the next unused VMID in the cluster.',
    'read',
    connectionParam,
    async (c) => {
      const id = await c.request<string>('/cluster/nextid');
      return ok(`Next free VMID: ${id}`, { vmid: Number(id) });
    },
  ),

  // ---- write tier ----
  ...(['start', 'shutdown', 'stop', 'reboot'] as const).map((action) =>
    tool(
      `proxmox_vm_${action}`,
      `${action[0]!.toUpperCase()}${action.slice(1)} guest`,
      `${action[0]!.toUpperCase()}${action.slice(1)} a VM or container.` +
        (action === 'stop' ? ' Hard stop — prefer shutdown for a clean poweroff.' : ''),
      'write',
      guestParams,
      async (c, a) => {
        const task = await c.request<string>(`${guestPath(a)}/status/${action}`, 'POST', {});
        return ok(`${action} requested for ${a.type} ${a.vmid} (task ${task})`, { task });
      },
    ),
  ),
  tool(
    'proxmox_vm_create',
    'Create VM',
    'Create a new QEMU VM. Pass provider-specific options via extra (e.g. net0, ide2).',
    'write',
    {
      ...connectionParam,
      node: z.string(),
      vmid: z.number().int(),
      name: z.string(),
      cores: z.number().int().default(2),
      memoryMb: z.number().int().default(2048),
      diskGb: z.number().int().optional(),
      storage: z.string().optional().describe('Storage pool for the disk'),
      extra: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    },
    async (c, a) => {
      const body: Record<string, unknown> = {
        vmid: a.vmid,
        name: a.name,
        cores: a.cores,
        memory: a.memoryMb,
        ...(a.diskGb && a.storage ? { scsi0: `${a.storage}:${a.diskGb}` } : {}),
        ...(a.extra as Record<string, unknown> | undefined),
      };
      const task = await c.request<string>(`/nodes/${a.node}/qemu`, 'POST', body);
      return ok(`VM ${a.vmid} (${a.name}) creation started (task ${task})`, { task });
    },
  ),
  tool(
    'proxmox_lxc_create',
    'Create LXC container',
    'Create a new LXC container from a template.',
    'write',
    {
      ...connectionParam,
      node: z.string(),
      vmid: z.number().int(),
      ostemplate: z.string().describe('e.g. local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst'),
      hostname: z.string().optional(),
      memoryMb: z.number().int().default(1024),
      diskGb: z.number().int().default(8),
      storage: z.string().default('local-lvm'),
      password: z.string().optional().describe('Root password for the container'),
      extra: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    },
    async (c, a) => {
      const body: Record<string, unknown> = {
        vmid: a.vmid,
        ostemplate: a.ostemplate,
        hostname: a.hostname,
        memory: a.memoryMb,
        rootfs: `${a.storage}:${a.diskGb}`,
        ...(a.password ? { password: a.password } : {}),
        ...(a.extra as Record<string, unknown> | undefined),
      };
      const task = await c.request<string>(`/nodes/${a.node}/lxc`, 'POST', body);
      return ok(`LXC ${a.vmid} creation started (task ${task})`, { task });
    },
  ),
  tool(
    'proxmox_vm_clone',
    'Clone guest',
    'Clone a VM or container to a new VMID.',
    'write',
    {
      ...guestParams,
      newid: z.number().int(),
      name: z.string().optional(),
      full: z.boolean().optional().describe('Full clone instead of linked'),
    },
    async (c, a) => {
      const task = await c.request<string>(`${guestPath(a)}/clone`, 'POST', {
        newid: a.newid,
        ...(a.name ? { name: a.name } : {}),
        ...(a.full !== undefined ? { full: a.full ? 1 : 0 } : {}),
      });
      return ok(`Clone of ${a.vmid} → ${a.newid} started (task ${task})`, { task });
    },
  ),
  tool(
    'proxmox_snapshot_create',
    'Create snapshot',
    'Snapshot a VM or container.',
    'write',
    { ...guestParams, snapname: z.string(), description: z.string().optional() },
    async (c, a) => {
      const task = await c.request<string>(`${guestPath(a)}/snapshot`, 'POST', {
        snapname: a.snapname,
        ...(a.description ? { description: a.description } : {}),
      });
      return ok(`Snapshot "${a.snapname}" of ${a.type} ${a.vmid} started (task ${task})`, { task });
    },
  ),

  // ---- destructive tier (confirm: true required) ----
  tool(
    'proxmox_vm_delete',
    'Delete guest',
    'PERMANENTLY delete a VM or container and its disks. Requires confirm: true.',
    'destructive',
    { ...guestParams, confirm: z.boolean().describe('Must be true — restate what is deleted') },
    async (c, a) => {
      const task = await c.request<string>(guestPath(a), 'DELETE');
      return ok(`Deletion of ${a.type} ${a.vmid} started (task ${task})`, { task });
    },
  ),
  tool(
    'proxmox_snapshot_delete',
    'Delete snapshot',
    'PERMANENTLY delete a snapshot. Requires confirm: true.',
    'destructive',
    { ...guestParams, snapname: z.string(), confirm: z.boolean() },
    async (c, a) => {
      const task = await c.request<string>(`${guestPath(a)}/snapshot/${a.snapname}`, 'DELETE');
      return ok(`Snapshot "${a.snapname}" deletion started (task ${task})`, { task });
    },
  ),
  tool(
    'proxmox_snapshot_rollback',
    'Roll back to snapshot',
    'Roll a guest back to a snapshot — current state is LOST. Requires confirm: true.',
    'destructive',
    { ...guestParams, snapname: z.string(), confirm: z.boolean() },
    async (c, a) => {
      const task = await c.request<string>(
        `${guestPath(a)}/snapshot/${a.snapname}/rollback`,
        'POST',
        {},
      );
      return ok(`Rollback of ${a.type} ${a.vmid} to "${a.snapname}" started (task ${task})`, {
        task,
      });
    },
  ),
  tool(
    'proxmox_backup_delete',
    'Delete backup',
    'PERMANENTLY delete a backup volume. Requires confirm: true.',
    'destructive',
    {
      ...connectionParam,
      node: z.string(),
      storage: z.string(),
      volid: z.string(),
      confirm: z.boolean(),
    },
    async (c, a) => {
      await c.request(`/nodes/${a.node}/storage/${a.storage}/content/${a.volid}`, 'DELETE');
      return ok(`Backup ${a.volid} deleted.`, { deleted: a.volid });
    },
  ),
];

export const proxmoxDriver: InfraDriver = {
  id: 'proxmox',
  kind: 'hypervisor',
  async probe(conn: ConnectionConfig, ctx: DriverContext) {
    try {
      const secret = ctx.settings.resolveSecret(conn);
      if (!secret) return { reachable: false, error: 'no resolvable tokenSecret' };
      const client = new ProxmoxClient(conn, secret, proxmoxFetch ?? fetch);
      const v = await client.version();
      return { reachable: true, version: `Proxmox VE ${v.version}` };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  tools(ctx: DriverContext): ToolModule[] {
    return TOOLS.map((t) => t(ctx));
  },
};
