// Banco de dados SQLite (sql.js — 100% JavaScript, sem compilação) e regras de importação.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import initSqlJs from 'sql.js';
import { NaoEhNFe, parseNFe } from './nfe.js';
import { parseDanfe } from './danfe.js';

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PADRAO = path.join(BASE, 'dados');

// Testa se a pasta pode ser criada e gravada.
function gravavel(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const teste = path.join(dir, `.teste-${process.pid}`);
    fs.writeFileSync(teste, 'ok');
    fs.rmSync(teste);
    return true;
  } catch (e) {
    console.error(`[arquivo-nfe] Não foi possível gravar em ${dir}: ${e.message}`);
    return false;
  }
}

// Se NFE_DADOS apontar para uma pasta inválida, usa a pasta padrão e avisa na tela
// (em vez de derrubar a aplicação).
export let AVISO_DADOS = null;
let dadosEscolhido = path.resolve(process.env.NFE_DADOS || PADRAO);
if (process.env.NFE_DADOS && !gravavel(dadosEscolhido)) {
  AVISO_DADOS = `A pasta definida em NFE_DADOS (${dadosEscolhido}) não pode ser usada. `
    + `Os dados estão sendo gravados temporariamente em ${PADRAO} e podem ser apagados na próxima implantação. `
    + 'Corrija a variável NFE_DADOS na hospedagem.';
  dadosEscolhido = PADRAO;
}
export const DADOS = dadosEscolhido;
export const ARQUIVOS = path.join(DADOS, 'arquivos');
export const ENTRADA = path.join(DADOS, 'entrada');
const DB_PATH = path.join(DADOS, 'notas.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empresas (
    cnpj TEXT PRIMARY KEY,
    nome TEXT, fantasia TEXT, ie TEXT, crt TEXT, email TEXT,
    logradouro TEXT, numero TEXT, complemento TEXT, bairro TEXT,
    municipio TEXT, uf TEXT, cep TEXT, fone TEXT,
    atualizado_em TEXT
);
CREATE TABLE IF NOT EXISTS notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT UNIQUE,
    numero TEXT, serie TEXT, modelo TEXT,
    data_emissao TEXT, dh_emissao TEXT, dh_saida_entrada TEXT,
    natureza_operacao TEXT, tipo_nf TEXT, finalidade TEXT, uf_codigo TEXT, ambiente TEXT,
    emit_cnpj TEXT, dest_cnpj TEXT,
    v_bc REAL, v_icms REAL, v_bcst REAL, v_st REAL, v_prod REAL, v_frete REAL, v_seg REAL,
    v_desc REAL, v_ipi REAL, v_pis REAL, v_cofins REAL, v_outro REAL, v_nf REAL, v_tot_trib REAL,
    mod_frete TEXT, transp_cnpj TEXT, transp_nome TEXT,
    vol_qtd REAL, vol_especie TEXT, peso_liquido REAL, peso_bruto REAL,
    inf_complementar TEXT, inf_fisco TEXT,
    protocolo TEXT, status_codigo TEXT, status_motivo TEXT, dh_autorizacao TEXT,
    fatura_numero TEXT, fatura_v_liq REAL,
    origem TEXT NOT NULL,
    arquivo_xml TEXT, arquivo_pdf TEXT, hash_xml TEXT, hash_pdf TEXT,
    texto_pdf TEXT,
    observacao TEXT,
    importado_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_notas_emit ON notas(emit_cnpj);
CREATE INDEX IF NOT EXISTS ix_notas_dest ON notas(dest_cnpj);
CREATE INDEX IF NOT EXISTS ix_notas_data ON notas(data_emissao);
CREATE TABLE IF NOT EXISTS itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_id INTEGER NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
    n_item INTEGER, cprod TEXT, cean TEXT, xprod TEXT, ncm TEXT, cest TEXT, cfop TEXT,
    ucom TEXT, qcom REAL, vuncom REAL, vprod REAL, utrib TEXT, qtrib REAL, vuntrib REAL,
    vfrete REAL, vseg REAL, vdesc REAL, voutro REAL, xped TEXT, nitemped TEXT,
    icms_orig TEXT, icms_cst TEXT, icms_vbc REAL, icms_picms REAL, icms_vicms REAL,
    icms_vbcst REAL, icms_vicmsst REAL,
    ipi_cst TEXT, ipi_pipi REAL, ipi_vipi REAL,
    pis_cst TEXT, pis_vpis REAL, cofins_cst TEXT, cofins_vcofins REAL,
    vtottrib REAL, inf_ad_prod TEXT
);
CREATE INDEX IF NOT EXISTS ix_itens_nota ON itens(nota_id);
CREATE INDEX IF NOT EXISTS ix_itens_cprod ON itens(cprod);
CREATE INDEX IF NOT EXISTS ix_itens_ncm ON itens(ncm);
CREATE TABLE IF NOT EXISTS duplicatas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_id INTEGER NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
    n_dup TEXT, vencimento TEXT, valor REAL
);
CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nota_id INTEGER NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
    tipo TEXT, descricao TEXT, valor REAL
);
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    criado_em TEXT
);
`;

const NOTA_COLS = [
  'chave', 'numero', 'serie', 'modelo', 'data_emissao', 'dh_emissao', 'dh_saida_entrada',
  'natureza_operacao', 'tipo_nf', 'finalidade', 'uf_codigo', 'ambiente',
  'v_bc', 'v_icms', 'v_bcst', 'v_st', 'v_prod', 'v_frete', 'v_seg', 'v_desc', 'v_ipi',
  'v_pis', 'v_cofins', 'v_outro', 'v_nf', 'v_tot_trib', 'mod_frete', 'transp_cnpj',
  'transp_nome', 'vol_qtd', 'vol_especie', 'peso_liquido', 'peso_bruto',
  'inf_complementar', 'inf_fisco', 'protocolo', 'status_codigo', 'status_motivo',
  'dh_autorizacao', 'fatura_numero', 'fatura_v_liq',
];
const ITEM_COLS = [
  'n_item', 'cprod', 'cean', 'xprod', 'ncm', 'cest', 'cfop', 'ucom', 'qcom', 'vuncom',
  'vprod', 'utrib', 'qtrib', 'vuntrib', 'vfrete', 'vseg', 'vdesc', 'voutro', 'xped',
  'nitemped', 'icms_orig', 'icms_cst', 'icms_vbc', 'icms_picms', 'icms_vicms',
  'icms_vbcst', 'icms_vicmsst', 'ipi_cst', 'ipi_pipi', 'ipi_vipi', 'pis_cst', 'pis_vpis',
  'cofins_cst', 'cofins_vcofins', 'vtottrib', 'inf_ad_prod',
];
const EMPRESA_COLS = ['nome', 'fantasia', 'ie', 'crt', 'email', 'logradouro', 'numero',
  'complemento', 'bairro', 'municipio', 'uf', 'cep', 'fone'];

export function norm(s) {
  if (s == null) return '';
  return String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

// ------------------------------------------------------------------ conexão
let SQL;
let banco;

function configurar() {
  banco.create_function('norm', (s) => norm(s));
  banco.run('PRAGMA foreign_keys = ON');
}

export async function abrir() {
  fs.mkdirSync(ARQUIVOS, { recursive: true });
  fs.mkdirSync(ENTRADA, { recursive: true });
  SQL = await initSqlJs();
  banco = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  configurar();
  banco.exec(SCHEMA);
  banco.run(`UPDATE itens SET icms_orig = substr(icms_cst, 1, 1), icms_cst = substr(icms_cst, 2)
    WHERE icms_orig IS NULL AND length(icms_cst) IN (3, 4)
      AND nota_id IN (SELECT id FROM notas WHERE origem = 'pdf')`);
  salvar();
}

const limpa = (params) => (params || []).map((v) => (v === undefined ? null : v));

export function all(sql, params) {
  const st = banco.prepare(sql);
  try {
    st.bind(limpa(params));
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}

export const get = (sql, params) => all(sql, params)[0];
export const valor = (sql, params) => {
  const r = get(sql, params);
  return r ? Object.values(r)[0] : undefined;
};
export function run(sql, params) {
  banco.run(sql, limpa(params));
}
const ultimoId = () => valor('SELECT last_insert_rowid()');

// Grava o banco em disco (escrita atômica). Chamado após cada alteração.
export function salvar() {
  const dados = banco.export(); // export() fecha/reabre o banco: refaz funções e pragmas
  configurar();
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(dados));
  fs.renameSync(tmp, DB_PATH);
}

function transacao(fn) {
  run('BEGIN');
  try {
    const r = fn();
    run('COMMIT');
    return r;
  } catch (e) {
    run('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------------ importação
const agora = () => new Date().toISOString().slice(0, 19);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function salvarArquivo(nomeBase, ext, conteudo) {
  const seguro = (nomeBase.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)) || 'arquivo';
  const rel = `${seguro}.${ext}`;
  fs.writeFileSync(path.join(ARQUIVOS, rel), conteudo);
  return rel;
}

function upsertEmpresa(p) {
  const cnpj = p && p.cnpj;
  if (!cnpj) return null;
  const vals = Object.fromEntries(EMPRESA_COLS.filter((k) => p[k]).map((k) => [k, p[k]]));
  const ks = Object.keys(vals);
  if (get('SELECT cnpj FROM empresas WHERE cnpj=?', [cnpj])) {
    if (ks.length) {
      run(`UPDATE empresas SET ${ks.map((k) => `${k}=?`).join(', ')}, atualizado_em=? WHERE cnpj=?`,
        [...Object.values(vals), agora(), cnpj]);
    }
  } else {
    const cols = ['cnpj', ...ks, 'atualizado_em'];
    run(`INSERT INTO empresas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      [cnpj, ...Object.values(vals), agora()]);
  }
  return cnpj;
}

function gravarFilhos(notaId, dados) {
  run('DELETE FROM itens WHERE nota_id=?', [notaId]);
  run('DELETE FROM duplicatas WHERE nota_id=?', [notaId]);
  run('DELETE FROM pagamentos WHERE nota_id=?', [notaId]);
  const sqlItem = `INSERT INTO itens (nota_id,${ITEM_COLS.join(',')}) VALUES (?${',?'.repeat(ITEM_COLS.length)})`;
  for (const it of dados.itens) run(sqlItem, [notaId, ...ITEM_COLS.map((c) => it[c] ?? null)]);
  for (const d of dados.duplicatas) {
    run('INSERT INTO duplicatas (nota_id,n_dup,vencimento,valor) VALUES (?,?,?,?)', [notaId, d.n_dup, d.vencimento, d.valor]);
  }
  for (const p of dados.pagamentos) {
    run('INSERT INTO pagamentos (nota_id,tipo,descricao,valor) VALUES (?,?,?,?)', [notaId, p.tipo, p.descricao, p.valor]);
  }
}

function gravarNota(dados, origem, extra, notaId = null) {
  const n = dados.nota;
  const vals = Object.fromEntries(NOTA_COLS.map((c) => [c, n[c] ?? null]));
  Object.assign(vals, {
    emit_cnpj: upsertEmpresa(dados.emitente), dest_cnpj: upsertEmpresa(dados.destinatario),
    origem, importado_em: agora(), ...extra,
  });
  const ks = Object.keys(vals);
  if (notaId == null) {
    run(`INSERT INTO notas (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, Object.values(vals));
    notaId = ultimoId();
  } else {
    run(`UPDATE notas SET ${ks.map((k) => `${k}=?`).join(', ')} WHERE id=?`, [...Object.values(vals), notaId]);
  }
  gravarFilhos(notaId, dados);
  return notaId;
}

function importarXml(nome, conteudo) {
  const h = sha(conteudo);
  if (get('SELECT 1 FROM notas WHERE hash_xml=?', [h])) {
    return { arquivo: nome, status: 'ignorado', msg: 'Arquivo já importado anteriormente' };
  }
  let dados;
  try {
    dados = parseNFe(conteudo);
  } catch (e) {
    if (e instanceof NaoEhNFe) return { arquivo: nome, status: 'erro', msg: e.message };
    throw e;
  }
  const n = dados.nota;
  const existente = n.chave ? get('SELECT id, origem FROM notas WHERE chave=?', [n.chave]) : null;
  if (existente && existente.origem === 'xml') {
    return { arquivo: nome, status: 'ignorado', msg: `NF-e ${n.numero} já cadastrada`, nota_id: existente.id };
  }
  const rel = salvarArquivo(n.chave || h.slice(0, 20), 'xml', conteudo);
  const extra = { arquivo_xml: rel, hash_xml: h };
  let notaId;
  let msg;
  if (existente) {
    notaId = transacao(() => gravarNota(dados, 'xml', { ...extra, observacao: null }, existente.id));
    msg = `NF-e ${n.numero} completada com o XML (já havia o PDF)`;
  } else {
    notaId = transacao(() => gravarNota(dados, 'xml', extra));
    msg = `NF-e ${n.numero} importada (${dados.itens.length} itens)`;
  }
  let aviso = '';
  if (n.status_codigo && !['100', '150'].includes(n.status_codigo)) {
    aviso = ` — atenção: situação SEFAZ ${n.status_codigo} ${n.status_motivo || ''}`;
  } else if (!n.protocolo) {
    aviso = ' — atenção: XML sem protocolo de autorização';
  }
  return { arquivo: nome, status: 'ok', msg: msg + aviso, nota_id: notaId };
}

async function importarPdf(nome, conteudo) {
  const h = sha(conteudo);
  if (get('SELECT 1 FROM notas WHERE hash_pdf=?', [h])) {
    return { arquivo: nome, status: 'ignorado', msg: 'Arquivo já importado anteriormente' };
  }
  const dados = await parseDanfe(conteudo);
  const n = dados.nota;
  const existente = n.chave ? get('SELECT id, numero FROM notas WHERE chave=?', [n.chave]) : null;
  if (existente) {
    const rel = salvarArquivo(n.chave, 'pdf', conteudo);
    run('UPDATE notas SET arquivo_pdf=?, hash_pdf=?, texto_pdf=? WHERE id=?', [rel, h, dados.texto, existente.id]);
    return { arquivo: nome, status: 'ok', msg: `DANFE anexado à NF-e ${existente.numero}`, nota_id: existente.id };
  }
  if (!dados.texto.trim()) return { arquivo: nome, status: 'erro', msg: 'Não foi possível ler o texto do PDF' };
  if (!n.chave && !n.v_nf) {
    return { arquivo: nome, status: 'erro', msg: 'PDF não parece ser um DANFE (chave de acesso não encontrada)' };
  }
  const rel = salvarArquivo(n.chave || h.slice(0, 20), 'pdf', conteudo);
  const obs = `Importada somente do PDF (leitura via ${dados.metodo}). Os dados podem estar incompletos; importe o XML para completar.`;
  const notaId = transacao(() => gravarNota(dados, 'pdf', { arquivo_pdf: rel, hash_pdf: h, texto_pdf: dados.texto, observacao: obs }));
  return {
    arquivo: nome, status: 'ok', nota_id: notaId,
    msg: `DANFE ${n.numero || ''} importado do PDF (${dados.itens.length} itens reconhecidos) — dados aproximados`,
  };
}

async function importarUm(nome, conteudo) {
  const baixo = nome.toLowerCase();
  if (baixo.endsWith('.zip')) {
    const res = [];
    let zip;
    try {
      zip = new AdmZip(conteudo);
    } catch {
      return [{ arquivo: nome, status: 'erro', msg: 'ZIP inválido' }];
    }
    const entradas = zip.getEntries()
      .filter((e) => !e.isDirectory && e.header.size <= 50 * 1024 * 1024 && /\.(xml|pdf|zip)$/i.test(e.entryName))
      .map((e) => [e.entryName, e]);
    for (const [n, e] of ordenarXmlPrimeiro(entradas)) res.push(...(await importarUm(`${nome}/${n}`, e.getData())));
    return res;
  }
  try {
    const inicio = conteudo.subarray(0, 64).toString('utf8').trimStart();
    if (baixo.endsWith('.xml') || inicio.startsWith('<')) return [importarXml(nome, conteudo)];
    if (baixo.endsWith('.pdf') || inicio.startsWith('%PDF')) return [await importarPdf(nome, conteudo)];
    return [{ arquivo: nome, status: 'erro', msg: 'Tipo de arquivo não suportado (use XML, PDF ou ZIP)' }];
  } catch (e) {
    return [{ arquivo: nome, status: 'erro', msg: `Falha inesperada: ${e.message}` }];
  }
}

// XML antes de PDF, para que o PDF seja anexado à nota já criada.
export function ordenarXmlPrimeiro(lista) {
  const peso = (n) => (/\.(xml|zip)$/i.test(n) ? 0 : 1);
  return [...lista].sort((a, b) => peso(a[0]) - peso(b[0]) || a[0].localeCompare(b[0]));
}

// Importa vários arquivos: [[nome, Buffer], ...]
export async function importarArquivos(lista) {
  const res = [];
  let n = 0;
  for (const [nome, conteudo] of ordenarXmlPrimeiro(lista)) {
    res.push(...(await importarUm(nome, conteudo)));
    if (++n % 50 === 0) salvar();
  }
  salvar();
  return res;
}

export async function importarPastaEntrada() {
  const processados = path.join(ENTRADA, 'processados');
  fs.mkdirSync(processados, { recursive: true });
  const arquivos = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== processados) varrer(p); } else if (/\.(xml|pdf|zip)$/i.test(e.name)) arquivos.push([e.name, p]);
    }
  };
  varrer(ENTRADA);
  const res = [];
  for (const [nome, caminho] of ordenarXmlPrimeiro(arquivos)) {
    const r = await importarUm(nome, fs.readFileSync(caminho));
    res.push(...r);
    if (r.every((x) => x.status !== 'erro')) {
      let destino = path.join(processados, nome);
      if (fs.existsSync(destino)) destino = path.join(processados, `${Date.now()}_${nome}`);
      fs.renameSync(caminho, destino);
    }
  }
  salvar();
  return res;
}

export function excluirNota(id) {
  const row = get('SELECT arquivo_xml, arquivo_pdf FROM notas WHERE id=?', [id]);
  if (!row) return;
  transacao(() => {
    run('DELETE FROM itens WHERE nota_id=?', [id]);
    run('DELETE FROM duplicatas WHERE nota_id=?', [id]);
    run('DELETE FROM pagamentos WHERE nota_id=?', [id]);
    run('DELETE FROM notas WHERE id=?', [id]);
  });
  salvar();
  for (const rel of [row.arquivo_xml, row.arquivo_pdf]) {
    if (rel) fs.rmSync(path.join(ARQUIVOS, rel), { force: true });
  }
}
