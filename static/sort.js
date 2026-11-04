// Optional enhancement: click a leaderboard column header to sort by it.
// Without JavaScript the table stays in its default, pre-rendered order.
(function () {
  for (const table of document.querySelectorAll('table[data-sortable]')) {
    const tbody = table.tBodies[0];
    const original = Array.from(tbody.rows);
    const headers = Array.from(table.tHead.rows[0].cells);
    headers.forEach((th, col) => {
      const button = th.querySelector('button[data-sort]');
      if (!button) return;
      button.addEventListener('click', () => {
        headers.forEach((h) => h.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', 'descending');
        if (th.hasAttribute('data-sort-default')) {
          original.forEach((row) => { row.hidden = false; tbody.appendChild(row); });
          return;
        }
        const value = (row) => {
          const v = row.cells[col]?.dataset.v;
          return v === undefined || v === '' ? null : Number(v);
        };
        const entries = original.filter((row) => row.classList.contains('entry'));
        entries.sort((a, b) => {
          const va = value(a);
          const vb = value(b);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return vb - va;
        });
        original.forEach((row) => { if (!row.classList.contains('entry')) row.hidden = true; });
        entries.forEach((row) => tbody.appendChild(row));
      });
    });
  }
})();
