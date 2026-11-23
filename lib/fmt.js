// Formatação brasileira para as páginas.

export function brl(v, casas = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const [int, dec] = Math.abs(n).toFixed(casas).split('.');
  const milhar = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + milhar + (dec ? `,${dec}` : '');
}

export const moeda = (v) => (v === null || v === undefined ? '—' : `R$ ${brl(v)}`);

export function qtd(v) {
  if (v === null || v === undefined) return '—';
  return brl(v, 4).replace(/0+$/, '').replace(/,$/, '');
}

// valor numérico opcional: vazio quando nulo
export const opc = (v, casas = 2) => (v === null || v === undefined ? '' : brl(v, casas));

export function data(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(v);
  if (!m) return v;
  return `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}` : ''}`;
}

export function doc(v) {
  if (!v) return '—';
  const d = String(v).replace(/\D/g, '');
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return v;
}

export const chave = (v) => (v ? v.match(/.{1,4}/g).join(' ') : '—');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const escapar = esc;

// Árvore do XML em HTML (já escapado).
export function arvoreHtml(no) {
  if (!no) return '';
  const attrs = Object.entries(no.attrs).map(([k, v]) => ` <span class="a">${esc(k)}="${esc(v)}"</span>`).join('');
  let h = `<li><span class="t">&lt;${esc(no.tag)}${attrs}&gt;</span>`;
  if (no.texto && !no.filhos.length) h += ` ${esc(no.texto)}`;
  if (no.filhos.length) h += `<ul>${no.filhos.map(arvoreHtml).join('')}</ul>`;
  return `${h}</li>`;
}
