import type { DiscoveryCache } from './settings.js';

/** Human-readable output of the discovery phase. */
export function renderEnvironmentMd(d: DiscoveryCache): string {
  const lines: string[] = [
    '# MCP Environment',
    '',
    `Discovered by vo-infra-mcp on ${d.at}. Re-run \`env_discover\` to refresh.`,
    '',
    '## Hardware',
    '',
    `- Platform: ${d.hardware.platform} (${d.hardware.arch})`,
    `- CPU: ${d.hardware.cpuModel} × ${d.hardware.cpuCount}`,
    `- Memory: ${d.hardware.totalMemGb} GB`,
    '',
    '## Runtimes and Tools',
    '',
  ];
  if (d.runtimes.length === 0) {
    lines.push('- (none detected)');
  }
  for (const r of d.runtimes) {
    lines.push(`- **${r.name}** — ${r.version} (\`${r.path}\`)`);
  }
  lines.push('', '## Container Runtimes', '');
  const containerEntries = Object.entries(d.containers);
  if (containerEntries.length === 0) {
    lines.push('- No running container daemon detected.');
  }
  for (const [name, info] of containerEntries) {
    lines.push(`- **${name}** — ${info}`);
  }
  lines.push('', '## Hypervisors', '');
  if (d.hypervisors.length === 0) {
    lines.push('- No hypervisor connections configured. Add one to MCP_SETTINGS.json.');
  }
  for (const h of d.hypervisors) {
    lines.push(
      `- **${h.connection}** (${h.driver}) — ${h.reachable ? `reachable${h.version ? `, ${h.version}` : ''}` : 'NOT reachable'}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
