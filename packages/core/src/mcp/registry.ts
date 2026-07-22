/**
 * Client for the official MCP registry (registry.modelcontextprotocol.io) —
 * the standards-compliant way to discover servers. Entries map straight to
 * runnable stdio configs: npm → npx, pypi → uvx, oci → docker run.
 */

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
}

export interface RegistryInstallCandidate {
  command: string;
  args: string[];
  envVars: RegistryEnvVar[];
  registryType: string;
}

export interface McpRegistryEntry {
  /** Reverse-DNS registry name, e.g. io.github.owner/repo */
  name: string;
  displayName: string;
  description: string;
  homepage?: string;
  install?: RegistryInstallCandidate;
  /** Present when the server is remote-only (not yet supported by our stdio client). */
  remoteUrl?: string;
}

interface RawPackage {
  registryType?: string;
  registry_type?: string;
  identifier?: string;
  name?: string;
  version?: string;
  environmentVariables?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    is_required?: boolean;
    isSecret?: boolean;
    is_secret?: boolean;
  }>;
}

interface RawServer {
  name?: string;
  description?: string;
  repository?: { url?: string };
  packages?: RawPackage[];
  remotes?: Array<{ url?: string }>;
}

function toCandidate(pkg: RawPackage): RegistryInstallCandidate | null {
  const type = (pkg.registryType ?? pkg.registry_type ?? '').toLowerCase();
  const id = pkg.identifier ?? pkg.name;
  if (!id) return null;
  const envVars: RegistryEnvVar[] = (pkg.environmentVariables ?? []).map((v) => ({
    name: v.name,
    description: v.description,
    isRequired: v.isRequired ?? v.is_required,
    isSecret: v.isSecret ?? v.is_secret,
  }));
  if (type === 'npm') {
    const spec = pkg.version ? `${id}@${pkg.version}` : id;
    return { command: 'npx', args: ['-y', spec], envVars, registryType: 'npm' };
  }
  if (type === 'pypi') {
    return { command: 'uvx', args: [id], envVars, registryType: 'pypi' };
  }
  if (type === 'oci') {
    return { command: 'docker', args: ['run', '--rm', '-i', id], envVars, registryType: 'oci' };
  }
  return null;
}

export interface SearchOptions {
  baseUrl?: string;
  limit?: number;
  fetchFn?: typeof fetch;
}

export async function searchMcpRegistry(
  query: string,
  opts: SearchOptions = {},
): Promise<McpRegistryEntry[]> {
  const base = (opts.baseUrl ?? 'https://registry.modelcontextprotocol.io').replace(/\/+$/, '');
  const url = `${base}/v0/servers?search=${encodeURIComponent(query)}&limit=${opts.limit ?? 20}&version=latest`;
  const res = await (opts.fetchFn ?? fetch)(url, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MCP registry returned ${res.status}`);
  const json = (await res.json()) as { servers?: Array<RawServer | { server?: RawServer }> };

  const entries: McpRegistryEntry[] = [];
  for (const raw of json.servers ?? []) {
    // The v0 API has shipped both flattened and { server: {...} } shapes.
    const s: RawServer = 'server' in raw && raw.server ? raw.server : (raw as RawServer);
    if (!s.name) continue;
    const install =
      (s.packages ?? []).map(toCandidate).find((c): c is RegistryInstallCandidate => c !== null) ??
      undefined;
    const remoteUrl = s.remotes?.[0]?.url;
    if (!install && !remoteUrl) continue;
    entries.push({
      name: s.name,
      displayName: s.name.split('/').pop() ?? s.name,
      description: s.description ?? '',
      homepage: s.repository?.url,
      install,
      remoteUrl: install ? undefined : remoteUrl,
    });
  }
  return entries;
}

/** A registry name like io.github.owner/repo → safe local server name. */
export function suggestServerName(entry: McpRegistryEntry, taken: string[]): string {
  let base = entry.displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Iteratively strip mcp/server affixes: github-mcp-server → github.
  let prev = '';
  while (prev !== base) {
    prev = base;
    base = base.replace(/^(mcp|server)-|-(mcp|server)$/g, '');
  }
  if (!base) base = 'server';
  let name = base;
  let n = 2;
  while (taken.includes(name)) name = `${base}-${n++}`;
  return name;
}
