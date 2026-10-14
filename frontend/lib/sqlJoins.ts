/**
 * Finds the JOINs in a SELECT statement so the answer card can draw them as
 * Venn circles. A light-weight scan (not a full SQL parser): it understands
 * `FROM a [AS] x  [INNER|LEFT|RIGHT|FULL|CROSS] [OUTER] JOIN b [AS] y ON …`
 * and `USING (…)`, which covers the SQL the assistant writes.
 */

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'cross';

export interface JoinInfo {
  kind: JoinKind;
  /** Table on the left of the join (resolved from the ON condition when possible) */
  left: string;
  /** Table being joined in */
  right: string;
  /** Column pairs the two tables share, e.g. [["customer_id", "customer_id"]] */
  on: [string, string][];
  /** The raw condition text, for the tooltip */
  condition: string;
}

const KEYWORDS = new Set([
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'outer',
  'natural',
  'where',
  'group',
  'order',
  'having',
  'limit',
  'union',
  'offset',
  'fetch',
  'window',
  'lateral',
  'straight_join',
]);

const unquote = (s: string) => s.replace(/[`"[\]]/g, '');
/** "public.orders" → "orders" */
const bareName = (s: string) => unquote(s).split('.').pop() || s;

/** Remove comments and string literals so keywords inside them are not matched */
function clean(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const TABLE = String.raw`((?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]))*|\()`;
// An alias is any word after the table that is not the next keyword (ON, LEFT, WHERE …)
const ALIAS = String.raw`(?:\s+(?:AS\s+)?(?!(?:${Array.from(KEYWORDS).join('|')})\b)([\w$]+))?`;

export function parseJoins(sql: string | undefined | null): JoinInfo[] {
  if (!sql || !/\bjoin\b/i.test(sql)) return [];
  const text = clean(sql);

  // alias → table name, filled as FROM / JOIN clauses are read
  const aliases = new Map<string, string>();
  const remember = (table: string, alias?: string) => {
    aliases.set(table.toLowerCase(), table);
    if (alias && !KEYWORDS.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), table);
  };

  const fromRe = new RegExp(String.raw`\bFROM\s+` + TABLE + ALIAS, 'gi');
  let firstTable: string | null = null;
  for (const m of Array.from(text.matchAll(fromRe))) {
    if (m[1] === '(') continue;
    const t = bareName(m[1]);
    remember(t, m[2]);
    firstTable ??= t;
  }

  const joinRe = new RegExp(
    String.raw`\b(?:(NATURAL)\s+)?(?:(INNER|LEFT|RIGHT|FULL|CROSS)\s+)?(?:OUTER\s+)?JOIN\s+` +
      TABLE +
      ALIAS,
    'gi',
  );
  const found: { kind: JoinKind; right: string; start: number; end: number }[] = [];
  for (const m of Array.from(text.matchAll(joinRe))) {
    const kind = (m[2]?.toLowerCase() as JoinKind) || 'inner';
    const right = m[3] === '(' ? 'subquery' : bareName(m[3]);
    if (m[3] !== '(') remember(right, m[4]);
    found.push({ kind, right, start: m.index!, end: m.index! + m[0].length });
  }

  const resolve = (ref: string) => aliases.get(ref.toLowerCase()) || ref;

  const joins: JoinInfo[] = [];
  let previous = firstTable || 'left table';
  found.forEach((j, i) => {
    // Condition = text after this JOIN up to the next clause keyword
    const tail = text.slice(j.end, i + 1 < found.length ? found[i + 1].start : undefined);
    const stop = tail.search(
      /\b(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION|OFFSET|FETCH)\b|;/i,
    );
    const clause = (stop >= 0 ? tail.slice(0, stop) : tail).trim();

    const on: [string, string][] = [];
    let left = previous;
    let condition = '';

    const using = clause.match(/^USING\s*\(([^)]*)\)/i);
    if (using) {
      condition = `USING (${using[1].trim()})`;
      using[1].split(',').forEach(c => {
        const col = unquote(c.trim());
        if (col) on.push([col, col]);
      });
    } else if (/^ON\b/i.test(clause)) {
      condition = clause
        .replace(/^ON\s+/i, '')
        .replace(/\s+/g, ' ')
        .replace(/\)+$/, '');
      const eqRe = /([\w$`"[\]]+)\.([\w$`"[\]]+)\s*=\s*([\w$`"[\]]+)\.([\w$`"[\]]+)/g;
      for (const m of Array.from(condition.matchAll(eqRe))) {
        const [ta, ca, tb, cb] = [
          resolve(unquote(m[1])),
          unquote(m[2]),
          resolve(unquote(m[3])),
          unquote(m[4]),
        ];
        if (tb === j.right) {
          on.push([ca, cb]);
          left = ta;
        } else if (ta === j.right) {
          on.push([cb, ca]);
          left = tb;
        } else {
          on.push([ca, cb]);
        }
      }
    }

    joins.push({ kind: j.kind, left, right: j.right, on, condition });
    previous = j.right;
  });
  return joins;
}
