import { SortIcon } from './ui';

/**
 * columns: [{ key, label, sortable?, sortKey?, align?: 'right', width?, render?(row, ctx) }]
 * sort: { key, dir } · onSort(key) toggles.
 */
export default function DataTable({ columns, rows, loading, sort, onSort, onRowClick, selectedId, ctx, skeletonRows = 8 }) {
  const showSkeleton = loading && !rows.length;
  return (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => {
              const sk = c.sortKey || c.key;
              const active = sort && sort.key === sk;
              return (
                <th
                  key={c.key}
                  className={[c.sortable ? 'sortable' : '', active ? 'sorted' : '', c.align === 'right' ? 'num' : ''].filter(Boolean).join(' ')}
                  style={c.width ? { width: c.width } : undefined}
                  onClick={c.sortable && onSort ? () => onSort(sk) : undefined}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.label}
                  {c.sortable ? <SortIcon active={active} dir={sort && sort.dir} /> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody style={loading && rows.length ? { opacity: 0.55, transition: 'opacity .15s' } : undefined}>
          {showSkeleton
            ? Array.from({ length: skeletonRows }, (_, r) => (
              <tr key={`s${r}`}>
                {columns.map((c, i) => (
                  <td key={c.key}><span className="skel" style={{ width: `${48 + ((r * 7 + i * 13) % 40)}%` }} /></td>
                ))}
              </tr>
            ))
            : rows.map((row) => (
              <tr
                key={row.id}
                className={[onRowClick ? 'clickable' : '', selectedId === row.id ? 'selected' : ''].filter(Boolean).join(' ')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={[c.align === 'right' ? 'num' : '', c.wrap ? 'wrap' : ''].filter(Boolean).join(' ')}>
                    {c.render ? c.render(row, ctx) : (row[c.key] ?? <span className="faint">—</span>)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
