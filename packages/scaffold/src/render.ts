/**
 * Tiny markdown-preserving renderer. Templates stay valid, readable markdown:
 *
 * - `{{path.to.value}}` substitutes from the context (missing → '' + warning)
 * - `<!-- when: expr -->…<!-- /when -->` keeps or drops a block; nestable
 *
 * Expression grammar: `key`, `key == "value"`, `key != "value"` — key is a
 * dot-path into the context; a bare key tests truthiness (non-empty string).
 * The comment markers double as section delimiters for the future
 * negotiable-markdown feature.
 */

export interface RenderResult {
  output: string;
  warnings: string[];
}

const MARKER_RE = /<!--\s*when:\s*(.*?)\s*-->|<!--\s*\/when\s*-->/g;

type Node = string | { expr: string; children: Node[] };

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  const exprStack: string[] = [];
  let last = 0;
  for (const match of template.matchAll(MARKER_RE)) {
    const text = template.slice(last, match.index);
    if (text) stack[stack.length - 1]!.push(text);
    last = match.index + match[0].length;
    if (match[1] !== undefined) {
      const block = { expr: match[1], children: [] as Node[] };
      stack[stack.length - 1]!.push(block);
      stack.push(block.children);
      exprStack.push(match[1]);
    } else {
      if (stack.length === 1) {
        throw new Error('Unbalanced <!-- /when --> without an opening <!-- when: -->');
      }
      stack.pop();
      exprStack.pop();
    }
  }
  if (stack.length !== 1) {
    throw new Error(`Unclosed <!-- when: ${exprStack[exprStack.length - 1]} -->`);
  }
  const tail = template.slice(last);
  if (tail) root.push(tail);
  return root;
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let value: unknown = ctx;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== '';
}

function evaluate(expr: string, ctx: Record<string, unknown>, warnings: string[]): boolean {
  const cmp = expr.match(/^(\S+)\s*(==|!=)\s*(.+)$/);
  if (cmp) {
    const [, key, op, rawValue] = cmp;
    const expected = rawValue!.trim().replace(/^["']|["']$/g, '');
    const actual = lookup(ctx, key!);
    const actualStr = actual === undefined || actual === null ? '' : String(actual);
    return op === '==' ? actualStr === expected : actualStr !== expected;
  }
  if (!/^[\w.]+$/.test(expr)) {
    warnings.push(`Unrecognized when-expression: "${expr}" (treated as false)`);
    return false;
  }
  return truthy(lookup(ctx, expr));
}

function substitute(text: string, ctx: Record<string, unknown>, warnings: string[]): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) {
      warnings.push(`Unknown template key: {{${path}}}`);
      return '';
    }
    return String(value);
  });
}

function renderNodes(
  nodes: Node[],
  ctx: Record<string, unknown>,
  warnings: string[],
): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += substitute(node, ctx, warnings);
    } else if (evaluate(node.expr, ctx, warnings)) {
      out += renderNodes(node.children, ctx, warnings);
    }
  }
  return out;
}

export function render(template: string, ctx: Record<string, unknown>): RenderResult {
  const warnings: string[] = [];
  const output = renderNodes(parse(template), ctx, warnings)
    // Collapse the blank lines left behind by dropped blocks.
    .replace(/\n{3,}/g, '\n\n');
  return { output, warnings };
}
