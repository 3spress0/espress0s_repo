/* global document */
(async function () {
  const root = document.getElementById('root');
  const q = document.getElementById('q');
  let spec;
  try {
    spec = await (await fetch('/api/docs/json', { credentials: 'same-origin' })).json();
  } catch {
    root.textContent = 'Could not load /api/docs/json';
    return;
  }
  document.getElementById('title').textContent = spec.info.title + ' · v' + spec.info.version;

  const ops = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      ops.push({ path, method: method.toUpperCase(), op, tag: (op.tags && op.tags[0]) || 'Other' });
    }
  }
  ops.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  document.getElementById('count').textContent = ops.length + ' operations';

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
    for (const c of children || []) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  function pre(obj) { return el('pre', { text: JSON.stringify(obj, null, 2) }); }

  function render(filter) {
    root.textContent = '';
    const f = (filter || '').trim().toLowerCase();
    let currentTag = null;
    let shown = 0;
    for (const o of ops) {
      const hay = (o.method + ' ' + o.path + ' ' + o.tag + ' ' + (o.op.summary || '')).toLowerCase();
      if (f && !hay.includes(f)) continue;
      shown++;
      if (o.tag !== currentTag) { currentTag = o.tag; root.appendChild(el('h2', { text: o.tag })); }
      const body = [];
      if (o.op.description) body.push(el('p', { text: o.op.description }));
      if (o.op.parameters && o.op.parameters.length) { body.push(el('p', { text: 'Parameters' })); body.push(pre(o.op.parameters)); }
      if (o.op.requestBody) { body.push(el('p', { text: 'Request body' })); body.push(pre(o.op.requestBody)); }
      if (o.op.responses && Object.keys(o.op.responses).length) { body.push(el('p', { text: 'Responses' })); body.push(pre(o.op.responses)); }
      const d = el('details', {}, [
        el('summary', {}, [
          el('span', { class: 'm ' + o.method, text: o.method }),
          el('code', { class: 'path', text: o.path }),
          el('span', { class: 'sum', text: o.op.summary || '' }),
          o.op.security ? el('span', { class: 'lock', text: '🔒' }) : '',
        ]),
        el('div', { class: 'body' }, body),
      ]);
      root.appendChild(d);
    }
    if (!shown) root.appendChild(el('p', { text: 'No operations match.' }));
  }
  render('');
  q.addEventListener('input', () => render(q.value));
})();
