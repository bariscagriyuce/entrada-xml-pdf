// Leitura aproximada (heurística) de DANFE em PDF.
// O XML é sempre a fonte preferida; o PDF serve para anexar o DANFE a uma nota
// já importada (pela chave de acesso) ou criar um registro provisório.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MONEY = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}`;
const NUM = String.raw`\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?`;
const CNPJ_RE = String.raw`\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}`;

export function brFloat(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const cacheCmd = new Map();
async function temComando(cmd) {
  if (!cacheCmd.has(cmd)) {
    const achou = (process.env.PATH || '').split(path.delimiter).some((d) => {
      try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; }
    });
    cacheCmd.set(cmd, achou);
  }
  return cacheCmd.get(cmd);
}

// Reconstrói o texto preservando colunas (semelhante ao "pdftotext -layout").
async function textoPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const paginas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const itens = tc.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
    if (!itens.length) continue;
    const larguras = itens.filter((i) => i.s.length > 1 && i.w > 0).map((i) => i.w / i.s.length).sort((a, b) => a - b);
    const cw = larguras.length ? larguras[Math.floor(larguras.length / 2)] : 5;
    itens.sort((a, b) => b.y - a.y || a.x - b.x);
    const linhas = [];
    for (const it of itens) {
      const l = linhas.find((ln) => Math.abs(ln.y - it.y) <= 2);
      if (l) l.itens.push(it);
      else linhas.push({ y: it.y, itens: [it] });
    }
    const saida = [];
    let yAnt = null;
    for (const ln of linhas) {
      if (yAnt !== null && yAnt - ln.y > cw * 4) saida.push('');
      yAnt = ln.y;
      ln.itens.sort((a, b) => a.x - b.x);
      let s = '';
      for (const it of ln.itens) {
        const col = Math.round(it.x / cw);
        if (s.length < col) s += ' '.repeat(col - s.length);
        else if (s.length && !s.endsWith(' ')) s += ' ';
        s += it.s;
      }
      saida.push(s);
    }
    paginas.push(saida.join('\n'));
  }
  await doc.destroy();
  return paginas.join('\n\f');
}

export async function extrairTexto(buf) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'danfe-'));
  const arq = path.join(td, 'doc.pdf');
  fs.writeFileSync(arq, buf);
  try {
    if (await temComando('pdftotext')) {
      try {
        const { stdout } = await run('pdftotext', ['-layout', arq, '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
        if (stdout.trim().length > 50) return { texto: stdout, metodo: 'pdftotext' };
      } catch { /* tenta o próximo */ }
    }
    try {
      const t = await textoPdfjs(buf);
      if (t.trim().length > 50) return { texto: t, metodo: 'pdf.js' };
    } catch { /* tenta OCR */ }
    if ((await temComando('pdftoppm')) && (await temComando('tesseract'))) {
      try {
        await run('pdftoppm', ['-r', '300', '-png', arq, path.join(td, 'pg')], { timeout: 180000 });
        const { stdout: langs } = await run('tesseract', ['--list-langs']);
        const lang = /\npor/.test(langs) ? 'por' : 'eng';
        const textos = [];
        for (const img of fs.readdirSync(td).filter((n) => n.startsWith('pg')).sort()) {
          const { stdout } = await run('tesseract', [path.join(td, img), '-', '-l', lang, '--psm', '6'],
            { maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
          textos.push(stdout);
        }
        const t = textos.join('\n');
        if (t.trim()) return { texto: t, metodo: 'ocr' };
      } catch { /* sem OCR */ }
    }
    return { texto: '', metodo: 'nenhum' };
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
}

export function chaveValida(ch) {
  if (!/^\d{44}$/.test(ch)) return false;
  const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
  const corpo = ch.slice(0, 43).split('').reverse();
  const soma = corpo.reduce((s, d, i) => s + Number(d) * pesos[i % 8], 0);
  const resto = soma % 11;
  const dv = resto < 2 ? 0 : 11 - resto;
  return dv === Number(ch[43]);
}

export function acharChave(texto) {
  const cands = texto.match(/(?:\d[ .]?){44}/g) || [];
  const limpos = cands.map((c) => c.replace(/\D/g, '').slice(0, 44));
  return limpos.find(chaveValida) || limpos.find((d) => d.length === 44) || null;
}

function apos(texto, rotulo, padrao, janela = 400) {
  const m = new RegExp(rotulo, 'i').exec(texto);
  if (!m) return null;
  const fim = m.index + m[0].length;
  const m2 = new RegExp(padrao).exec(texto.slice(fim, fim + janela));
  return m2 ? m2[0] : null;
}

// Valor posicionado abaixo do rótulo (mesma coluna), como no layout do DANFE.
function valorColuna(texto, rotulo, padrao = MONEY) {
  const linhas = texto.split('\n');
  const re = new RegExp(rotulo, 'i');
  for (let i = 0; i < linhas.length; i++) {
    const m = re.exec(linhas[i]);
    if (!m) continue;
    const ini = m.index;
    const fim = m.index + m[0].length;
    const resto = linhas[i].slice(fim, fim + 25);
    const mesma = new RegExp(padrao).exec(resto);
    if (mesma && !/[A-Za-z]{3}/.test(resto.slice(0, mesma.index))) return mesma[0];
    for (const prox of linhas.slice(i + 1, i + 4)) {
      let melhor = null;
      const g = new RegExp(padrao, 'g');
      let v;
      while ((v = g.exec(prox))) {
        const vFim = v.index + v[0].length;
        if (vFim >= ini - 4 && v.index <= fim + 4) {
          const dist = Math.abs(v.index - ini);
          if (!melhor || dist < melhor[0]) melhor = [dist, v[0]];
        }
      }
      if (melhor) return melhor[1];
    }
  }
  return apos(texto, rotulo, padrao);
}

function linhaApos(texto, rotulo) {
  const linhas = texto.split('\n');
  const re = new RegExp(rotulo, 'i');
  for (let i = 0; i < linhas.length - 1; i++) {
    const m = re.exec(linhas[i]);
    if (!m) continue;
    const trecho = linhas[i + 1].slice(Math.max(0, m.index - 2)).trim();
    if (trecho) return trecho.split(/\s{3,}/)[0].trim();
  }
  return null;
}

const ITEM_RE = new RegExp(
  String.raw`^\s*(?<cod>\S{1,30})\s+(?<desc>.+?)\s+(?<ncm>\d{8})\s+(?<cst>\d{3,4})\s+` +
  String.raw`(?<cfop>[1-7]\d{3})\s+(?<un>[A-Za-zÇç]{1,6}\.?\d?)\s+(?<q>${NUM})\s+` +
  String.raw`(?<vu>${NUM})\s+(?<vt>${NUM})`,
);

export async function parseDanfe(buf) {
  const { texto, metodo } = await extrairTexto(buf);
  const chave = texto ? acharChave(texto) : null;
  const nota = { chave, modelo: null, serie: null, numero: null };
  let emitCnpj = null;
  if (chave) {
    emitCnpj = chave.slice(6, 20);
    nota.modelo = chave.slice(20, 22);
    nota.serie = String(parseInt(chave.slice(22, 25), 10));
    nota.numero = String(parseInt(chave.slice(25, 34), 10));
  }
  if (!nota.numero) {
    const m = /N[º°o.]\s*:?\s*(\d{1,3}(?:\.\d{3})+|\d{1,9})/.exec(texto);
    if (m) nota.numero = String(parseInt(m[1].replace(/\./g, ''), 10));
  }
  const dt = valorColuna(texto, String.raw`DATA\s+(?:DA|DE)\s+EMISS`, String.raw`\d{2}\/\d{2}\/\d{4}`)
    || (texto.match(/\d{2}\/\d{2}\/\d{4}/) || [null])[0];
  if (dt) {
    const [d, mm, y] = dt.split('/');
    nota.data_emissao = `${y}-${mm}-${d}`;
    nota.dh_emissao = nota.data_emissao;
  }
  nota.v_nf = brFloat(valorColuna(texto, String.raw`VALOR\s+TOTAL\s+DA\s+NOTA`));
  nota.v_prod = brFloat(valorColuna(texto, String.raw`VALOR\s+TOTAL\s+DOS\s+PRODUTOS`));
  nota.v_icms = brFloat(valorColuna(texto, String.raw`VALOR\s+DO\s+ICMS(?!\s+S)`));
  nota.v_ipi = brFloat(valorColuna(texto, String.raw`VALOR\s+(?:TOTAL\s+)?(?:DO\s+)?IPI`));
  nota.v_frete = brFloat(valorColuna(texto, String.raw`VALOR\s+DO\s+FRETE`));
  nota.v_desc = brFloat(valorColuna(texto, 'DESCONTO'));
  nota.natureza_operacao = linhaApos(texto, String.raw`NATUREZA\s+DA\s+OPERA`);
  nota.protocolo = apos(texto, String.raw`PROTOCOLO\s+DE\s+AUTORIZA`, String.raw`\d{15}`);

  let emitNome = null;
  const mr = /RECEBEMOS\s+DE\s+([\s\S]+?)\s+OS\s+PRODUTOS/i.exec(texto);
  if (mr) emitNome = mr[1].replace(/\s+/g, ' ').trim();

  const cnpjs = (texto.match(new RegExp(CNPJ_RE, 'g')) || []).map((c) => c.replace(/\D/g, ''));
  if (!emitCnpj && cnpjs.length) emitCnpj = cnpjs[0];
  let destCnpj = null;
  let destNome = null;
  const pd = /DESTINAT[ÁA]RIO/i.exec(texto);
  if (pd) {
    const fim = pd.index + pd[0].length;
    const m = new RegExp(CNPJ_RE).exec(texto.slice(fim, fim + 1500));
    if (m) destCnpj = m[0].replace(/\D/g, '');
    destNome = linhaApos(texto.slice(pd.index), String.raw`NOME\s*\/\s*RAZ[ÃA]O\s+SOCIAL`);
  }

  const itens = [];
  for (const ln of texto.split('\n')) {
    const m = ITEM_RE.exec(ln);
    if (!m) continue;
    const g = m.groups;
    itens.push({
      n_item: itens.length + 1, cprod: g.cod, xprod: g.desc.replace(/\s{2,}/g, ' ').trim(),
      ncm: g.ncm, icms_cst: g.cst, cfop: g.cfop, ucom: g.un,
      qcom: brFloat(g.q), vuncom: brFloat(g.vu), vprod: brFloat(g.vt),
    });
  }

  return {
    nota,
    emitente: { cnpj: emitCnpj, nome: emitNome },
    destinatario: { cnpj: destCnpj, nome: destNome },
    itens, duplicatas: [], pagamentos: [], texto, metodo,
  };
}
