'use client';

/** Result table: sticky header, numbers right-aligned, first 500 rows (CSV has all). */
const isNumeric = (v: unknown) => typeof v === 'number';
// IDs, years and codes read better without thousands separators
const isPlainNumberCol = (name: string) => /(^id$|_id$|^year$|_year$|code$|zip|phone)/i.test(name);

export default function DataTable({
  columns,
  rows,
  maxHeight = 'max-h-96',
}: {
  columns: string[];
  rows: (string | number | null)[][];
  maxHeight?: string;
}) {
  // Right-align columns whose values are numbers
  const numericCol = columns.map((_, j) => rows.length > 0 && rows.every(r => r[j] === null || isNumeric(r[j])));
  const plainCol = columns.map(isPlainNumberCol);
  const shown = rows.slice(0, 500);
  return (
    <div className={`overflow-auto ${maxHeight}`}>
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-slate-50">
            {columns.map((c, j) => (
              <th
                key={c}
                className={`px-3 py-2 font-semibold text-slate-600 border-b border-slate-200 whitespace-nowrap ${
                  numericCol[j] ? 'text-right' : 'text-left'
                }`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-teal-50/40">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3 py-1.5 whitespace-nowrap ${
                    numericCol[j] ? 'text-right tabular-nums text-slate-900' : 'text-slate-700'
                  }`}
                >
                  {cell === null || cell === undefined ? (
                    <span className="text-slate-300 italic">null</span>
                  ) : isNumeric(cell) && !plainCol[j] ? (
                    (cell as number).toLocaleString(undefined, { maximumFractionDigits: 4 })
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="text-center text-xs text-slate-500 py-2 border-t border-slate-100">
          Showing the first {shown.length} of {rows.length.toLocaleString()} rows — download the CSV
          for all of them
        </p>
      )}
    </div>
  );
}

export function downloadCsv(columns: string[], rows: (string | number | null)[][]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columns.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `sqlanalyst-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
