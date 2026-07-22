import { describe, expect, it } from 'vitest';
import { McpAdvisor } from '../src/mcp/advisor.ts';
import { searchMcpRegistry, suggestServerName } from '../src/mcp/registry.ts';

const REGISTRY_FIXTURE = {
  servers: [
    {
      name: 'io.github.github/github-mcp-server',
      description: 'Official GitHub MCP server',
      repository: { url: 'https://github.com/github/github-mcp-server' },
      packages: [
        {
          registryType: 'npm',
          identifier: '@github/mcp-server',
          version: '1.2.3',
          environmentVariables: [
            { name: 'GITHUB_TOKEN', description: 'PAT', isRequired: true, isSecret: true },
          ],
        },
      ],
    },
    // Wrapped shape variant + pypi package
    {
      server: {
        name: 'io.github.someone/postgres-mcp',
        description: 'Query Postgres',
        packages: [{ registry_type: 'pypi', identifier: 'postgres-mcp' }],
      },
    },
    // Remote-only server
    {
      name: 'com.example/remote-only',
      description: 'Hosted server',
      remotes: [{ url: 'https://mcp.example.com/http' }],
    },
    // Unusable entry (no package, no remote) must be skipped
    { name: 'com.example/broken', description: 'nothing to run' },
  ],
};

function fixtureFetch() {
  const calls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(REGISTRY_FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('searchMcpRegistry', () => {
  it('maps npm/pypi packages to runnable stdio configs and keeps env metadata', async () => {
    const { fetchFn, calls } = fixtureFetch();
    const entries = await searchMcpRegistry('github', { fetchFn });
    expect(calls[0]).toContain('search=github');

    const gh = entries.find((e) => e.name.includes('github-mcp-server'))!;
    expect(gh.install).toEqual({
      command: 'npx',
      args: ['-y', '@github/mcp-server@1.2.3'],
      envVars: [{ name: 'GITHUB_TOKEN', description: 'PAT', isRequired: true, isSecret: true }],
      registryType: 'npm',
    });

    const pg = entries.find((e) => e.name.includes('postgres'))!;
    expect(pg.install).toMatchObject({ command: 'uvx', args: ['postgres-mcp'] });

    const remote = entries.find((e) => e.name.includes('remote-only'))!;
    expect(remote.install).toBeUndefined();
    expect(remote.remoteUrl).toBe('https://mcp.example.com/http');

    expect(entries.some((e) => e.name.includes('broken'))).toBe(false);
  });

  it('suggestServerName produces short unique names', async () => {
    const { fetchFn } = fixtureFetch();
    const entries = await searchMcpRegistry('github', { fetchFn });
    const gh = entries[0]!;
    expect(suggestServerName(gh, [])).toBe('github');
    expect(suggestServerName(gh, ['github'])).toBe('github-2');
  });
});

describe('McpAdvisor', () => {
  it('suggests after the topic threshold, once, with a registry query', () => {
    const advisor = new McpAdvisor();
    expect(advisor.observe('check the github issues for this repo', [])).toBeNull();
    const second = advisor.observe('now open a github pull request', []);
    expect(second).toMatchObject({ topic: 'github', query: 'github' });
    // Never re-suggests the same topic.
    expect(advisor.observe('more github stuff', [])).toBeNull();
  });

  it('stays quiet when a connected server already covers the topic', () => {
    const advisor = new McpAdvisor();
    advisor.observe('query the postgres database', ['postgres-db']);
    expect(advisor.observe('another postgres database question', ['postgres-db'])).toBeNull();
  });

  it('dismiss() suppresses future suggestions for that topic', () => {
    const advisor = new McpAdvisor();
    advisor.observe('scrape the web page', []);
    advisor.dismiss('web-browsing');
    expect(advisor.observe('scrape the web page again', [])).toBeNull();
  });

  it('unrelated chatter never triggers', () => {
    const advisor = new McpAdvisor();
    for (const msg of ['fix the button color', 'write a poem', 'refactor this function']) {
      expect(advisor.observe(msg, [])).toBeNull();
    }
  });
});
