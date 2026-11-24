// Arquivo de Notas de Entrada — aplicação web (Node.js + Express).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import * as auth from './lib/auth.js';
import * as db from './lib/db.js';
import * as fmt from './lib/fmt.js';
import { MOD_FRETE, ORIGEM, ORIGEM_CURTA, xmlParaArvore } from './lib/nfe.js';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { gerarDanfe, juntarPdfs } from './lib/gerar-pdf.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // ex.: "/notas" se a aplicação ficar em subpasta
const POR_PAGINA = 50;

await db.abrir();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(DIR, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.locals.base = BASE || '/';
const u = (p = '/') => (BASE + p) || '/';
Object.assign(app.locals, fmt, {
  MOD_FRETE, ORIGEM, ORIGEM_CURTA, u,
  // "0 - Nacional"; vazio quando a origem não é conhecida
  origem: (o) => (o == null || o === '' ? '' : `${o} - ${ORIGEM_CURTA[o] || 'Código desconhecido'}`),
  origens: (lista) => (lista || '').split(',').filter(Boolean).map((o) => `${o} - ${ORIGEM_CURTA[o] || '?'}`).join(' / '),
  origemLonga: (o) => (o == null || o === '' ? '' : `${o} - ${ORIGEM[o] || 'Código desconhecido'}`),
  purl: (cnpj, cprod) => u(`/produto?${new URLSearchParams({ cnpj: cnpj || '', cprod: cprod || '' })}`),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 2000 } });
const rotas = express.Router();
const assinc = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(BASE || '/', express.static(path.join(DIR, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ------------------------------------------------------------------ contexto das páginas
rotas.use((req, res, next) => {
  const q = req.query;
  res.locals.q = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]));
  res.locals.ep = req.path;
  res.locals.ok = res.locals.q.ok || null;
  res.locals.aviso = db.AVISO_DADOS;
  res.locals.urlCom = (mud) => {
    const args = { ...res.locals.q, ...mud };
    const qs = new URLSearchParams(Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    const s = qs.toString();
    return BASE + req.path + (s ? `?${s}` : '');
  };
  res.locals.ord = (campo, rotulo, cls = '') => `<th class="${cls}"><a href="${fmt.escapar(res.locals.urlCom({ ordem: campo, pag: null }))}">`
    + `${fmt.escapar(rotulo)}${res.locals.q.ordem === campo ? ' ▾' : ''}</a></th>`;
  next();
});

// ------------------------------------------------------------------ login
const temUsuarios = () => db.valor('SELECT COUNT(*) FROM usuarios') > 0;

rotas.get('/configurar', (req, res) => {
  if (temUsuarios()) return res.redirect(app.locals.u('/login'));
  res.render('configurar', { erro: null, usuario: null });
});
rotas.post('/configurar', (req, res) => {
  if (temUsuarios()) return res.redirect(app.locals.u('/login'));
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '');
  const erro = validarNovo(usuario, senha, req.body.senha2);
  if (erro) return res.render('configurar', { erro, usuario: null });
  db.run('INSERT INTO usuarios (usuario, senha_hash, criado_em) VALUES (?,?,?)', [usuario, auth.hashSenha(senha), new Date().toISOString()]);
  db.salvar();
  auth.iniciarSessao(req, res, usuario);
  res.redirect(app.locals.u('/'));
});

rotas.get('/login', (req, res) => {
  if (!temUsuarios()) return res.redirect(app.locals.u('/configurar'));
  res.render('login', { erro: null, usuario: null });
});
rotas.post('/login', (req, res) => {
  const ip = req.ip;
  if (auth.bloqueado(ip)) return res.status(429).render('login', { erro: 'Muitas tentativas. Aguarde 15 minutos.', usuario: null });
  const usuario = String(req.body.usuario || '').trim();
  const u = db.get('SELECT * FROM usuarios WHERE usuario=?', [usuario]);
  if (!u || !auth.conferirSenha(String(req.body.senha || ''), u.senha_hash)) {
    auth.registrarFalha(ip);
    return res.status(401).render('login', { erro: 'Usuário ou senha incorretos.', usuario: null });
  }
  auth.limparFalhas(ip);
  auth.iniciarSessao(req, res, u.usuario);
  res.redirect(app.locals.u('/'));
});
rotas.post('/sair', (req, res) => {
  auth.encerrarSessao(req, res);
  res.redirect(app.locals.u('/login'));
});

// Tudo abaixo exige login
rotas.use((req, res, next) => {
  if (!temUsuarios()) return res.redirect(app.locals.u('/configurar'));
  const u = auth.usuarioDaSessao(req);
  if (!u) return res.redirect(app.locals.u('/login'));
  res.locals.usuario = u;
  res.locals.minhasEmpresas = db.all(
    'SELECT DISTINCT e.cnpj, COALESCE(e.fantasia, e.nome, e.cnpj) AS nome FROM notas n '
    + 'JOIN empresas e ON e.cnpj = n.dest_cnpj ORDER BY 2');
  next();
});

function validarNovo(usuario, senha, senha2) {
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(usuario)) return 'Usuário deve ter 3 a 40 caracteres (letras, números, . _ @ -).';
  if (senha.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (senha !== String(senha2 || '')) return 'As senhas não conferem.';
  return null;
}

rotas.get('/usuarios', (req, res) => {
  res.render('usuarios', { lista: db.all('SELECT id, usuario, criado_em FROM usuarios ORDER BY usuario'), erro: null });
});
rotas.post('/usuarios', (req, res) => {
  const usuario = String(req.body.usuario || '').trim();
  const senha = String(req.body.senha || '');
  let erro = validarNovo(usuario, senha, req.body.senha2);
  if (!erro && db.get('SELECT 1 FROM usuarios WHERE usuario=?', [usuario])) erro = 'Este usuário já existe.';
  if (erro) return res.render('usuarios', { lista: db.all('SELECT id, usuario, criado_em FROM usuarios ORDER BY usuario'), erro });
  db.run('INSERT INTO usuarios (usuario, senha_hash, criado_em) VALUES (?,?,?)', [usuario, auth.hashSenha(senha), new Date().toISOString()]);
  db.salvar();
  res.redirect(app.locals.u('/usuarios?ok=Usuário criado.'));
});
rotas.post('/usuarios/:id/excluir', (req, res) => {
  const id = Number(req.params.id);
  if (id !== res.locals.usuario.id && db.valor('SELECT COUNT(*) FROM usuarios') > 1) {
    db.run('DELETE FROM usuarios WHERE id=?', [id]);
    db.salvar();
  }
  res.redirect(app.locals.u('/usuarios?ok=Usuário excluído.'));
});
rotas.post('/senha', (req, res) => {
  const u = db.get('SELECT * FROM usuarios WHERE id=?', [res.locals.usuario.id]);
  const lista = () => db.all('SELECT id, usuario, criado_em FROM usuarios ORDER BY usuario');
  if (!auth.conferirSenha(String(req.body.atual || ''), u.senha_hash)) return res.render('usuarios', { lista: lista(), erro: 'Senha atual incorreta.' });
  const erro = validarNovo(u.usuario, String(req.body.senha || ''), req.body.senha2);
  if (erro) return res.render('usuarios', { lista: lista(), erro });
  db.run('UPDATE usuarios SET senha_hash=? WHERE id=?', [auth.hashSenha(String(req.body.senha)), u.id]);
  db.salvar();
  res.redirect(app.locals.u('/usuarios?ok=Senha alterada.'));
});

// ------------------------------------------------------------------ filtros
function filtros(q, porItem = false) {
  const w = [];
  const p = [];
  const busca = (q.q || '').trim();
  if (busca) {
    const nq = `%${db.norm(busca)}%`;
    const dig = busca.replace(/\D/g, '');
    const cond = ['norm(e.nome) LIKE ?', 'norm(e.fantasia) LIKE ?', 'n.numero = ?',
      'norm(n.natureza_operacao) LIKE ?', 'norm(n.inf_complementar) LIKE ?'];
    p.push(nq, nq, busca.replace(/^0+/, '') || busca, nq, nq);
    if (dig.length >= 4) {
      cond.push('n.chave LIKE ?', 'n.emit_cnpj LIKE ?');
      p.push(`%${dig}%`, `%${dig}%`);
    }
    if (porItem) {
      cond.push('norm(i.xprod) LIKE ?', 'i.cprod = ?', 'i.cean = ?');
      p.push(nq, busca, busca);
    } else {
      cond.push('EXISTS (SELECT 1 FROM itens i2 WHERE i2.nota_id=n.id AND (norm(i2.xprod) LIKE ? OR i2.cprod = ? OR i2.cean = ?))');
      p.push(nq, busca, busca);
    }
    w.push(`(${cond.join(' OR ')})`);
  }
  if (q.emit) { w.push('n.emit_cnpj = ?'); p.push(q.emit); }
  if (q.dest) { w.push('n.dest_cnpj = ?'); p.push(q.dest); }
  if (q.de) { w.push('n.data_emissao >= ?'); p.push(q.de); }
  if (q.ate) { w.push('n.data_emissao <= ?'); p.push(q.ate); }
  if (q.origem) { w.push('n.origem = ?'); p.push(q.origem); }
  for (const [campo, op] of [['vmin', '>='], ['vmax', '<=']]) {
    if (!q[campo]) continue;
    const s = q[campo].includes(',') ? q[campo].replace(/\./g, '').replace(',', '.') : q[campo];
    const v = Number(s);
    if (Number.isFinite(v)) { w.push(`${porItem ? 'i.vprod' : 'n.v_nf'} ${op} ?`); p.push(v); }
  }
  if (/^[0-8]$/.test(q.orig || '')) {
    if (porItem) w.push('i.icms_orig = ?');
    else w.push('EXISTS (SELECT 1 FROM itens i3 WHERE i3.nota_id=n.id AND i3.icms_orig = ?)');
    p.push(q.orig);
  }
  if (porItem) {
    if (q.ncm) { w.push('i.ncm LIKE ?'); p.push(`${q.ncm.replace(/\D/g, '')}%`); }
    if (q.cfop) { w.push('i.cfop = ?'); p.push(q.cfop.trim()); }
  }
  return { where: w.length ? ` WHERE ${w.join(' AND ')}` : '', params: p };
}

function paginar(q, sqlCount, params) {
  const total = db.valor(sqlCount, params) || 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pag = Math.min(Math.max(1, parseInt(q.pag || '1', 10) || 1), paginas);
  return { total, pag, paginas, lim: ` LIMIT ${POR_PAGINA} OFFSET ${(pag - 1) * POR_PAGINA}` };
}

function csv(res, nome, cab, linhas) {
  const cel = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'number' && !Number.isInteger(v) ? fmt.qtd(v) : String(v);
    if (/[;"\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const corpo = [cab, ...linhas].map((l) => l.map(cel).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${nome}`);
  res.send(`﻿${corpo}`);
}

const fornecedoresLista = () => db.all('SELECT cnpj, nome FROM empresas WHERE cnpj IN (SELECT DISTINCT emit_cnpj FROM notas) ORDER BY nome');

// ------------------------------------------------------------------ páginas
rotas.get('/', (req, res) => {
  const r = db.get('SELECT COUNT(*) qtd, COALESCE(SUM(v_nf),0) total, COUNT(DISTINCT emit_cnpj) forn, '
    + 'MIN(data_emissao) primeira, MAX(data_emissao) ultima FROM notas');
  const mensal = db.all("SELECT substr(data_emissao,1,7) mes, COUNT(*) qtd, SUM(v_nf) total FROM notas "
    + 'WHERE data_emissao IS NOT NULL GROUP BY mes ORDER BY mes DESC LIMIT 12').reverse();
  res.render('painel', {
    r, mensal,
    itens: db.valor('SELECT COUNT(*) FROM itens'),
    pendentes: db.valor("SELECT COUNT(*) FROM notas WHERE origem='pdf'"),
    top: db.all('SELECT e.cnpj, COALESCE(e.nome, n.emit_cnpj) nome, COUNT(*) qtd, SUM(n.v_nf) total FROM notas n '
      + 'LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj GROUP BY n.emit_cnpj ORDER BY total DESC LIMIT 8'),
    nDest: db.valor('SELECT COUNT(DISTINCT dest_cnpj) FROM notas WHERE dest_cnpj IS NOT NULL'),
    destinatarios: db.all(`SELECT n.dest_cnpj cnpj, COALESCE(e.fantasia, e.nome, n.dest_cnpj) nome, e.municipio, e.uf,
      COUNT(*) qtd, SUM(n.v_nf) total, COUNT(DISTINCT n.emit_cnpj) forn, MAX(n.data_emissao) ultima
      FROM notas n LEFT JOIN empresas e ON e.cnpj=n.dest_cnpj GROUP BY n.dest_cnpj ORDER BY total DESC`),
    recentes: db.all('SELECT n.*, e.nome emit_nome, COALESCE(d.fantasia, d.nome) dest_nome FROM notas n LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj '
      + 'LEFT JOIN empresas d ON d.cnpj=n.dest_cnpj ORDER BY n.id DESC LIMIT 8'),
  });
});

const ORDENS_NOTAS = {
  data: 'n.data_emissao DESC, n.id DESC', data_asc: 'n.data_emissao ASC', valor: 'n.v_nf DESC',
  valor_asc: 'n.v_nf ASC', numero: 'CAST(n.numero AS INTEGER) DESC', fornecedor: 'e.nome ASC', importacao: 'n.id DESC',
};

rotas.get('/notas', (req, res) => {
  const q = res.locals.q;
  const { where, params } = filtros(q);
  const base = ` FROM notas n LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj LEFT JOIN empresas d ON d.cnpj=n.dest_cnpj${where}`;
  const ordem = ORDENS_NOTAS[q.ordem] || ORDENS_NOTAS.data;
  const sel = `SELECT n.id, n.chave, n.numero, n.serie, n.data_emissao, n.emit_cnpj, n.dest_cnpj, n.natureza_operacao,
    n.v_prod, n.v_frete, n.v_desc, n.v_ipi, n.v_icms, n.v_st, n.v_nf, n.origem, n.arquivo_xml, n.arquivo_pdf,
    e.nome emit_nome, COALESCE(d.fantasia, d.nome) dest_nome,
    (SELECT COUNT(*) FROM itens i WHERE i.nota_id=n.id) n_itens${base} ORDER BY ${ordem}`;
  if (q.formato === 'csv') {
    return csv(res, 'notas.csv',
      ['Chave', 'Número', 'Série', 'Emissão', 'Fornecedor', 'CNPJ Fornecedor', 'Destinatário', 'CNPJ Destinatário',
        'Natureza', 'Valor Produtos', 'Frete', 'Desconto', 'IPI', 'ICMS', 'ICMS ST', 'Valor Total', 'Itens', 'Origem'],
      db.all(sel, params).map((r) => [r.chave, r.numero, r.serie, r.data_emissao, r.emit_nome, r.emit_cnpj, r.dest_nome,
        r.dest_cnpj, r.natureza_operacao, r.v_prod, r.v_frete, r.v_desc, r.v_ipi, r.v_icms, r.v_st, r.v_nf, r.n_itens, r.origem]));
  }
  const pg = paginar(q, `SELECT COUNT(*)${base}`, params);
  res.render('notas', {
    ...pg, rows: db.all(sel + pg.lim, params), soma: db.valor(`SELECT COALESCE(SUM(n.v_nf),0)${base}`, params),
    fornecedores: fornecedoresLista(),
  });
});

rotas.get('/notas/:id(\\d+)', (req, res, next) => {
  const id = Number(req.params.id);
  const n = db.get('SELECT * FROM notas WHERE id=?', [id]);
  if (!n) return next();
  let arvore = null;
  if (n.arquivo_xml) {
    try { arvore = xmlParaArvore(fs.readFileSync(path.join(db.ARQUIVOS, n.arquivo_xml))); } catch { arvore = null; }
  }
  res.render('nota', {
    n, arvore,
    emit: db.get('SELECT * FROM empresas WHERE cnpj=?', [n.emit_cnpj]),
    dest: db.get('SELECT * FROM empresas WHERE cnpj=?', [n.dest_cnpj]),
    itens: db.all('SELECT * FROM itens WHERE nota_id=? ORDER BY n_item', [id]),
    dups: db.all('SELECT * FROM duplicatas WHERE nota_id=? ORDER BY vencimento', [id]),
    pags: db.all('SELECT * FROM pagamentos WHERE nota_id=?', [id]),
  });
});

rotas.get('/notas/:id(\\d+)/arquivo/:tipo(xml|pdf)', (req, res, next) => {
  const n = db.get('SELECT numero, chave, arquivo_xml, arquivo_pdf FROM notas WHERE id=?', [Number(req.params.id)]);
  const rel = n && n[`arquivo_${req.params.tipo}`];
  if (!rel) return next();
  const arq = path.join(db.ARQUIVOS, path.basename(rel));
  if (req.query.baixar === '1') return res.download(arq, `NFe_${n.numero || ''}_${n.chave || ''}.${req.params.tipo}`);
  res.type(req.params.tipo === 'pdf' ? 'application/pdf' : 'application/xml').sendFile(arq);
});

// ------------------------------------------------------------------ PDF e downloads em lote
function carregarNota(id) {
  const n = db.get('SELECT * FROM notas WHERE id=?', [id]);
  if (!n) return null;
  return {
    n,
    emit: db.get('SELECT * FROM empresas WHERE cnpj=?', [n.emit_cnpj]),
    dest: db.get('SELECT * FROM empresas WHERE cnpj=?', [n.dest_cnpj]),
    itens: db.all('SELECT * FROM itens WHERE nota_id=? ORDER BY n_item', [id]),
    dups: db.all('SELECT * FROM duplicatas WHERE nota_id=? ORDER BY vencimento', [id]),
    pags: db.all('SELECT * FROM pagamentos WHERE nota_id=?', [id]),
  };
}

const nomeBase = (n) => `NFe_${n.numero || 'sn'}_${n.serie || ''}_${(n.chave || String(n.id)).slice(-44)}`.replace(/[^\w.-]/g, '');

// PDF da nota: o DANFE original (se foi importado) ou um gerado a partir dos dados do XML.
async function pdfDaNota(id, gerado = false) {
  const dados = carregarNota(id);
  if (!dados) return null;
  if (dados.n.arquivo_pdf && !gerado) {
    try { return { n: dados.n, bytes: fs.readFileSync(path.join(db.ARQUIVOS, path.basename(dados.n.arquivo_pdf))) }; } catch { /* gera */ }
  }
  return { n: dados.n, bytes: Buffer.from(await gerarDanfe(dados)) };
}

rotas.get('/notas/:id(\\d+)/pdf', assinc(async (req, res, next) => {
  const r = await pdfDaNota(Number(req.params.id), req.query.gerado === '1');
  if (!r) return next();
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `${req.query.baixar === '1' ? 'attachment' : 'inline'}; filename="${nomeBase(r.n)}.pdf"`);
  res.send(r.bytes);
}));

// IDs de todas as notas do filtro atual (para "selecionar todas").
rotas.get('/notas/ids', (req, res) => {
  const { where, params } = filtros(res.locals.q);
  res.json(db.all(`SELECT n.id FROM notas n LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj${where}`, params).map((r) => r.id));
});

const LIMITE_LOTE = 2000;
rotas.post('/notas/lote', assinc(async (req, res) => {
  const ids = [...new Set(String(req.body.ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, LIMITE_LOTE);
  const formato = String(req.body.formato || '');
  if (!ids.length) return res.redirect(app.locals.u('/notas'));
  const notas = db.all(`SELECT id, numero, serie, chave, data_emissao, arquivo_xml FROM notas WHERE id IN (${ids.map(() => '?').join(',')})
    ORDER BY data_emissao, id`, ids);
  const carimbo = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
  if (formato === 'xml') {
    const zip = new AdmZip();
    const sem = [];
    for (const n of notas) {
      if (!n.arquivo_xml) { sem.push(`${n.numero || n.id} (${n.chave || 'sem chave'})`); continue; }
      try { zip.addFile(`${nomeBase(n)}.xml`, fs.readFileSync(path.join(db.ARQUIVOS, path.basename(n.arquivo_xml)))); } catch { sem.push(String(n.numero || n.id)); }
    }
    if (sem.length) zip.addFile('LEIA-ME.txt', Buffer.from(`Notas sem arquivo XML (importadas somente pelo PDF):\r\n${sem.join('\r\n')}\r\n`, 'utf8'));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="notas_xml_${carimbo}.zip"`);
    return res.send(zip.toBuffer());
  }
  if (formato === 'pdfzip') {
    const zip = new AdmZip();
    for (const n of notas) {
      const r = await pdfDaNota(n.id);
      if (r) zip.addFile(`${nomeBase(n)}.pdf`, r.bytes);
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="notas_pdf_${carimbo}.zip"`);
    return res.send(zip.toBuffer());
  }
  // PDF único com todas as notas, para imprimir
  const partes = [];
  for (const n of notas) {
    const r = await pdfDaNota(n.id);
    if (r) partes.push(r.bytes);
  }
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="notas_${carimbo}.pdf"`);
  res.send(Buffer.from(await juntarPdfs(partes)));
}));

rotas.post('/notas/:id(\\d+)/excluir', (req, res) => {
  db.excluirNota(Number(req.params.id));
  res.redirect(app.locals.u('/notas?ok=Nota excluída.'));
});

rotas.get('/fornecedores', (req, res) => {
  const q = res.locals.q;
  const busca = (q.q || '').trim();
  let w = '';
  let p = [];
  if (busca) {
    const nq = `%${db.norm(busca)}%`;
    w = ' WHERE norm(e.nome) LIKE ? OR norm(e.fantasia) LIKE ? OR e.cnpj LIKE ? OR norm(e.municipio) LIKE ?';
    p = [nq, nq, `%${busca.replace(/\D/g, '') || busca}%`, nq];
  }
  const ordem = { nome: 'e.nome', total: 'total DESC', qtd: 'qtd DESC', ultima: 'ultima DESC' }[q.ordem] || 'total DESC';
  res.render('fornecedores', {
    rows: db.all(`SELECT e.*, COUNT(n.id) qtd, SUM(n.v_nf) total, MIN(n.data_emissao) primeira, MAX(n.data_emissao) ultima
      FROM empresas e JOIN notas n ON n.emit_cnpj=e.cnpj${w} GROUP BY e.cnpj ORDER BY ${ordem}`, p),
  });
});

rotas.get('/fornecedores/:cnpj', (req, res, next) => {
  const cnpj = req.params.cnpj;
  const e = db.get('SELECT * FROM empresas WHERE cnpj=?', [cnpj]);
  if (!e) return next();
  res.render('fornecedor', {
    e,
    r: db.get('SELECT COUNT(*) qtd, SUM(v_nf) total, MIN(data_emissao) primeira, MAX(data_emissao) ultima FROM notas WHERE emit_cnpj=?', [cnpj]),
    notas: db.all('SELECT n.*, (SELECT COUNT(*) FROM itens i WHERE i.nota_id=n.id) n_itens FROM notas n WHERE emit_cnpj=? ORDER BY data_emissao DESC', [cnpj]),
    produtos: db.all(`SELECT i.cprod, MAX(i.xprod) xprod, MAX(i.ucom) ucom, GROUP_CONCAT(DISTINCT i.icms_orig) origens, COUNT(*) vezes, SUM(i.qcom) qtd, SUM(i.vprod) total,
      MIN(i.vuncom) pmin, MAX(i.vuncom) pmax, MAX(n.data_emissao) ultima FROM itens i JOIN notas n ON n.id=i.nota_id
      WHERE n.emit_cnpj=? GROUP BY i.cprod ORDER BY total DESC`, [cnpj]),
  });
});

rotas.get('/destinatarios', (req, res) => {
  const q = res.locals.q;
  const busca = (q.q || '').trim();
  let w = '';
  let p = [];
  if (busca) {
    const nq = `%${db.norm(busca)}%`;
    w = ' WHERE norm(e.nome) LIKE ? OR norm(e.fantasia) LIKE ? OR e.cnpj LIKE ? OR norm(e.municipio) LIKE ?';
    p = [nq, nq, `%${busca.replace(/\D/g, '') || busca}%`, nq];
  }
  const ordem = { nome: 'e.nome', total: 'total DESC', qtd: 'qtd DESC', ultima: 'ultima DESC' }[q.ordem] || 'total DESC';
  res.render('destinatarios', {
    rows: db.all(`SELECT e.*, COUNT(n.id) qtd, SUM(n.v_nf) total, COUNT(DISTINCT n.emit_cnpj) forn,
      MIN(n.data_emissao) primeira, MAX(n.data_emissao) ultima
      FROM empresas e JOIN notas n ON n.dest_cnpj=e.cnpj${w} GROUP BY e.cnpj ORDER BY ${ordem}`, p),
  });
});

rotas.get('/destinatarios/:cnpj', (req, res, next) => {
  const cnpj = req.params.cnpj;
  const e = db.get('SELECT * FROM empresas WHERE cnpj=?', [cnpj]);
  if (!e) return next();
  res.render('destinatario', {
    e,
    r: db.get(`SELECT COUNT(*) qtd, SUM(v_nf) total, COUNT(DISTINCT emit_cnpj) forn, MIN(data_emissao) primeira,
      MAX(data_emissao) ultima FROM notas WHERE dest_cnpj=?`, [cnpj]),
    fornecedores: db.all(`SELECT n.emit_cnpj cnpj, COALESCE(f.nome, n.emit_cnpj) nome, COUNT(*) qtd, SUM(n.v_nf) total,
      MAX(n.data_emissao) ultima FROM notas n LEFT JOIN empresas f ON f.cnpj=n.emit_cnpj
      WHERE n.dest_cnpj=? GROUP BY n.emit_cnpj ORDER BY total DESC`, [cnpj]),
    produtos: db.all(`SELECT n.emit_cnpj, f.nome emit_nome, i.cprod, MAX(i.xprod) xprod, MAX(i.ucom) ucom,
      GROUP_CONCAT(DISTINCT i.icms_orig) origens, COUNT(*) vezes, SUM(i.qcom) qtd, SUM(i.vprod) total,
      MAX(n.data_emissao) ultima FROM itens i JOIN notas n ON n.id=i.nota_id LEFT JOIN empresas f ON f.cnpj=n.emit_cnpj
      WHERE n.dest_cnpj=? GROUP BY n.emit_cnpj, i.cprod ORDER BY total DESC LIMIT 200`, [cnpj]),
    notas: db.all(`SELECT n.*, f.nome emit_nome, (SELECT COUNT(*) FROM itens i WHERE i.nota_id=n.id) n_itens
      FROM notas n LEFT JOIN empresas f ON f.cnpj=n.emit_cnpj WHERE n.dest_cnpj=? ORDER BY n.data_emissao DESC LIMIT 200`, [cnpj]),
  });
});

rotas.get('/produtos', (req, res) => {
  const q = res.locals.q;
  const { where, params } = filtros(q, true);
  const ordem = { total: 'total DESC', qtd: 'qtd DESC', nome: 'xprod', vezes: 'vezes DESC', ultima: 'ultima DESC' }[q.ordem] || 'total DESC';
  const agg = `SELECT n.emit_cnpj, e.nome emit_nome, i.cprod, MAX(i.xprod) xprod, MAX(i.cean) cean, MAX(i.ncm) ncm,
    MAX(i.ucom) ucom, GROUP_CONCAT(DISTINCT i.icms_orig) origens,
    COUNT(*) vezes, SUM(i.qcom) qtd, SUM(i.vprod) total, MIN(i.vuncom) pmin, MAX(i.vuncom) pmax,
    MAX(n.data_emissao) ultima,
    (SELECT i3.vuncom FROM itens i3 JOIN notas n3 ON n3.id=i3.nota_id WHERE n3.emit_cnpj IS n.emit_cnpj AND i3.cprod IS i.cprod
      ORDER BY n3.data_emissao DESC, n3.id DESC LIMIT 1) ultimo_preco
    FROM itens i JOIN notas n ON n.id=i.nota_id LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj${where}
    GROUP BY n.emit_cnpj, i.cprod`;
  if (q.formato === 'csv') {
    return csv(res, 'produtos.csv',
      ['Fornecedor', 'CNPJ', 'Código', 'Descrição', 'EAN', 'NCM', 'Origem', 'Unidade', 'Compras', 'Quantidade', 'Valor Total',
        'Menor Preço', 'Maior Preço', 'Último Preço', 'Última Compra'],
      db.all(`${agg} ORDER BY ${ordem}`, params).map((r) => [r.emit_nome, r.emit_cnpj, r.cprod, r.xprod, r.cean, r.ncm,
        (r.origens || '').split(',').filter(Boolean).map(app.locals.origem).join(' / '), r.ucom, r.vezes, r.qtd, r.total, r.pmin, r.pmax, r.ultimo_preco, r.ultima]));
  }
  const pg = paginar(q, `SELECT COUNT(*) FROM (${agg})`, params);
  res.render('produtos', { ...pg, rows: db.all(`${agg} ORDER BY ${ordem}${pg.lim}`, params), fornecedores: fornecedoresLista() });
});

rotas.get('/produto', (req, res, next) => {
  const cnpj = res.locals.q.cnpj || null;
  const cprod = res.locals.q.cprod || null;
  const hist = db.all(`SELECT i.*, n.id nid, n.numero, n.serie, n.data_emissao, n.dest_cnpj,
    COALESCE(d.fantasia, d.nome) dest_nome FROM itens i JOIN notas n ON n.id=i.nota_id
    LEFT JOIN empresas d ON d.cnpj=n.dest_cnpj WHERE n.emit_cnpj IS ? AND i.cprod IS ?
    ORDER BY n.data_emissao, n.id`, [cnpj, cprod]);
  if (!hist.length) return next();
  const ean = (hist.find((h) => h.cean && h.cean !== 'SEM GTIN') || {}).cean || null;
  const outros = ean ? db.all(`SELECT n.emit_cnpj, e.nome emit_nome, i.cprod, MAX(i.xprod) xprod, COUNT(*) vezes,
    MIN(i.vuncom) pmin, MAX(i.vuncom) pmax, MAX(n.data_emissao) ultima FROM itens i JOIN notas n ON n.id=i.nota_id
    LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj WHERE i.cean=? AND n.emit_cnpj IS NOT ? GROUP BY n.emit_cnpj, i.cprod`, [ean, cnpj]) : [];
  res.render('produto', {
    e: db.get('SELECT * FROM empresas WHERE cnpj=?', [cnpj]), hist, outros, ean, cprod,
    xprod: hist[hist.length - 1].xprod,
    precos: hist.map((h) => h.vuncom).filter((v) => v !== null),
    qtdTotal: hist.reduce((s, h) => s + (h.qcom || 0), 0),
    total: hist.reduce((s, h) => s + (h.vprod || 0), 0),
  });
});

rotas.get('/itens', (req, res) => {
  const q = res.locals.q;
  const { where, params } = filtros(q, true);
  const base = ` FROM itens i JOIN notas n ON n.id=i.nota_id LEFT JOIN empresas e ON e.cnpj=n.emit_cnpj${where}`;
  const ordem = { data: 'n.data_emissao DESC, n.id DESC, i.n_item', valor: 'i.vprod DESC', preco: 'i.vuncom DESC', nome: 'i.xprod' }[q.ordem]
    || 'n.data_emissao DESC, n.id DESC, i.n_item';
  const sel = `SELECT i.*, n.id nid, n.numero, n.serie, n.chave, n.data_emissao, n.emit_cnpj, e.nome emit_nome${base} ORDER BY ${ordem}`;
  if (q.formato === 'csv') {
    return csv(res, 'itens.csv',
      ['Emissão', 'NF', 'Série', 'Chave', 'Fornecedor', 'CNPJ', 'Item', 'Código', 'EAN', 'Descrição', 'NCM', 'CEST', 'CFOP',
        'Unidade', 'Quantidade', 'Valor Unitário', 'Valor Total', 'Desconto', 'Frete', 'Origem', 'Descrição da Origem', 'CST ICMS', 'BC ICMS', 'Alíq. ICMS',
        'ICMS', 'ICMS ST', 'Alíq. IPI', 'IPI', 'PIS', 'COFINS', 'Pedido'],
      db.all(sel, params).map((r) => [r.data_emissao, r.numero, r.serie, r.chave, r.emit_nome, r.emit_cnpj, r.n_item, r.cprod,
        r.cean, r.xprod, r.ncm, r.cest, r.cfop, r.ucom, r.qcom, r.vuncom, r.vprod, r.vdesc, r.vfrete, r.icms_orig, ORIGEM[r.icms_orig] || '', r.icms_cst, r.icms_vbc,
        r.icms_picms, r.icms_vicms, r.icms_vicmsst, r.ipi_pipi, r.ipi_vipi, r.pis_vpis, r.cofins_vcofins, r.xped]));
  }
  const pg = paginar(q, `SELECT COUNT(*)${base}`, params);
  res.render('itens', {
    ...pg, rows: db.all(sel + pg.lim, params), soma: db.valor(`SELECT COALESCE(SUM(i.vprod),0)${base}`, params),
    fornecedores: fornecedoresLista(),
  });
});

const nomeArquivo = (n) => {
  // navegadores enviam o nome em UTF-8, mas o multer o entrega como latin1
  const conv = Buffer.from(n, 'latin1').toString('utf8');
  return conv.includes('�') ? n : conv;
};

rotas.get('/importar', (req, res) => res.render('importar', { resultados: null, pasta: db.ENTRADA }));
rotas.post('/importar', upload.array('arquivos', 2000), assinc(async (req, res) => {
  const lista = (req.files || []).map((f) => [nomeArquivo(f.originalname || 'arquivo'), f.buffer]);
  const resultados = await db.importarArquivos(lista);
  res.render('importar', { resultados, pasta: db.ENTRADA });
}));
rotas.post('/importar/pasta', assinc(async (req, res) => {
  const resultados = await db.importarPastaEntrada();
  if (!resultados.length) res.locals.aviso = `Nenhum arquivo XML/PDF/ZIP encontrado em ${db.ENTRADA}`;
  res.render('importar', { resultados, pasta: db.ENTRADA });
}));

app.use(BASE || '/', rotas);

app.use((req, res) => {
  res.status(404).render('erro', { msg: 'Página ou registro não encontrado.', usuario: res.locals.usuario || null });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const msg = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais (limite de 50 MB por arquivo).' : `Erro no envio: ${err.message}`)
    : 'Erro interno. Tente novamente.';
  if (!(err instanceof multer.MulterError)) console.error(err);
  res.status(err instanceof multer.MulterError ? 413 : 500).render('erro', { msg, usuario: res.locals.usuario || null });
});

// A hospedagem pode informar um número de porta ou o caminho de um socket em PORT.
const portaEnv = process.env.PORT || process.env.NFE_PORTA || '3000';
const PORTA = /^\d+$/.test(portaEnv) ? Number(portaEnv) : portaEnv;
const HOST = process.env.NFE_HOST || undefined;
const servidor = typeof PORTA === 'number' && HOST ? app.listen(PORTA, HOST) : app.listen(PORTA);
servidor.on('listening', () => {
  console.log(`[arquivo-nfe] Node ${process.version} — ouvindo em ${HOST ? `${HOST}:` : ''}${PORTA}${BASE} — dados em ${db.DADOS}`);
});
servidor.on('error', (err) => {
  console.error(`[arquivo-nfe] Falha ao abrir a porta ${PORTA}:`, err);
  process.exit(1);
});
