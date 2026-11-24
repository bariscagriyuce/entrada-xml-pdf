// Gera um PDF no formato do DANFE a partir dos dados da nota (importados do XML),
// e junta vários PDFs em um só para impressão.
import bwipjs from 'bwip-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { brl, chave as fmtChave, data as fmtData, doc as docFmt } from './fmt.js';

const fmtDoc = (v) => (v ? docFmt(v) : '');
const fmtDataV = (v) => (v ? fmtData(v) : '');
import { MOD_FRETE } from './nfe.js';

const A4 = [595.28, 841.89];
const M = 18; // margem
const LARG = A4[0] - 2 * M;
const PRETO = rgb(0, 0, 0);
const CINZA = rgb(0.35, 0.35, 0.35);

// As fontes padrão do PDF só aceitam caracteres "WinAnsi" (Latin-1).
const TROCAS = { '≤': '<=', '≥': '>=', '–': '-', '—': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '•': '-' };
export function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => TROCAS[c] ?? '?');
}

const num = (v, casas = 2) => (v === null || v === undefined || v === '' ? '' : brl(v, casas));
const qtd = (v) => (v === null || v === undefined ? '' : brl(v, 4).replace(/0+$/, '').replace(/,$/, ''));

// Quebra o texto em linhas que caibam na largura.
function quebrar(fonte, tam, s, largura, maxLinhas = Infinity) {
  const palavras = texto(s).split(' ').filter(Boolean);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (fonte.widthOfTextAtSize(tentativa, tam) <= largura) atual = tentativa;
    else {
      if (atual) linhas.push(atual);
      atual = p;
      while (fonte.widthOfTextAtSize(atual, tam) > largura && atual.length > 1) {
        let corte = atual.length - 1;
        while (corte > 1 && fonte.widthOfTextAtSize(atual.slice(0, corte), tam) > largura) corte--;
        linhas.push(atual.slice(0, corte));
        atual = atual.slice(corte);
      }
    }
  }
  if (atual) linhas.push(atual);
  if (linhas.length > maxLinhas) {
    const l = linhas.slice(0, maxLinhas);
    let u = l[maxLinhas - 1];
    while (u.length && fonte.widthOfTextAtSize(`${u}...`, tam) > largura) u = u.slice(0, -1);
    l[maxLinhas - 1] = `${u}...`;
    return l;
  }
  return linhas;
}

function caber(fonte, tam, s, largura) {
  let t = texto(s);
  if (fonte.widthOfTextAtSize(t, tam) <= largura) return t;
  while (t.length && fonte.widthOfTextAtSize(`${t}...`, tam) > largura) t = t.slice(0, -1);
  return `${t}...`;
}

class Desenho {
  constructor(pdf, fontes) {
    this.pdf = pdf;
    this.f = fontes;
    this.paginas = [];
    this.novaPagina();
  }

  novaPagina() {
    this.pg = this.pdf.addPage(A4);
    this.paginas.push(this.pg);
    this.y = M; // y medido do topo
  }

  ret(x, y, w, h) {
    this.pg.drawRectangle({ x, y: A4[1] - y - h, width: w, height: h, borderColor: PRETO, borderWidth: 0.6 });
  }

  escrever(s, x, y, { tam = 7, negrito = false, cor = PRETO, larg = null, alinhar = 'esq' } = {}) {
    const fonte = negrito ? this.f.negrito : this.f.normal;
    const t = larg ? caber(fonte, tam, s, larg) : texto(s);
    let xx = x;
    if (larg && alinhar !== 'esq') {
      const w = fonte.widthOfTextAtSize(t, tam);
      xx = alinhar === 'dir' ? x + larg - w : x + (larg - w) / 2;
    }
    this.pg.drawText(t, { x: xx, y: A4[1] - y - tam, size: tam, font: fonte, color: cor });
  }

  // Caixa com rótulo pequeno em cima e valor embaixo.
  campo(x, y, w, h, rotulo, valor, { alinhar = 'esq', negrito = false, tam = 7.5 } = {}) {
    this.ret(x, y, w, h);
    this.escrever(rotulo, x + 2, y + 1.5, { tam: 5, cor: CINZA, larg: w - 4 });
    this.escrever(valor, x + 2, y + h - tam - 2, { tam, negrito, larg: w - 4, alinhar });
  }

  // Linha de campos: [rotulo, valor, fração da largura, opções]
  linha(campos, h = 20) {
    let x = M;
    const total = campos.reduce((s, c) => s + c[2], 0);
    campos.forEach((c, i) => {
      const w = i === campos.length - 1 ? M + LARG - x : (LARG * c[2]) / total;
      this.campo(x, this.y, w, h, c[0], c[1], c[3] || {});
      x += w;
    });
    this.y += h;
  }

  titulo(s) {
    this.escrever(s, M, this.y + 2, { tam: 6.5, negrito: true });
    this.y += 10;
  }
}

async function codigoDeBarras(chave) {
  if (!chave || !/^\d{44}$/.test(chave)) return null;
  try {
    return await bwipjs.toBuffer({ bcid: 'code128', text: chave, scale: 2, height: 9, includetext: false });
  } catch {
    return null;
  }
}

function cabecalho(d, n, emit, png, folhas) {
  const h = 92;
  const y = d.y;
  const wEmit = 232;
  const wDanfe = 92;
  const wChave = LARG - wEmit - wDanfe;
  // Emitente
  d.ret(M, y, wEmit, h);
  d.escrever('IDENTIFICAÇÃO DO EMITENTE', M + 2, y + 2, { tam: 5, cor: CINZA });
  const nome = quebrar(d.f.negrito, 9, emit?.nome || fmtDoc(n.emit_cnpj), wEmit - 8, 2);
  nome.forEach((l, i) => d.escrever(l, M + 4, y + 12 + i * 11, { tam: 9, negrito: true }));
  let yy = y + 14 + nome.length * 11;
  if (emit) {
    const end = [
      [emit.logradouro, emit.numero].filter(Boolean).join(', ') + (emit.complemento ? ` - ${emit.complemento}` : ''),
      [emit.bairro, emit.cep ? `CEP ${emit.cep}` : ''].filter(Boolean).join(' - '),
      [emit.municipio, emit.uf].filter(Boolean).join(' - ') + (emit.fone ? ` - Fone: ${emit.fone}` : ''),
    ].filter((l) => l.trim());
    for (const l of end) {
      d.escrever(l, M + 4, yy, { tam: 7, larg: wEmit - 8 });
      yy += 9;
    }
  }
  // Bloco DANFE
  const xd = M + wEmit;
  d.ret(xd, y, wDanfe, h);
  d.escrever('DANFE', xd, y + 5, { tam: 13, negrito: true, larg: wDanfe, alinhar: 'centro' });
  d.escrever('Documento Auxiliar da', xd, y + 21, { tam: 6.5, larg: wDanfe, alinhar: 'centro' });
  d.escrever('Nota Fiscal Eletrônica', xd, y + 29, { tam: 6.5, larg: wDanfe, alinhar: 'centro' });
  d.escrever('0 - ENTRADA', xd + 6, y + 40, { tam: 6.5 });
  d.escrever('1 - SAÍDA', xd + 6, y + 48, { tam: 6.5 });
  d.ret(xd + 66, y + 40, 16, 15);
  d.escrever(n.tipo_nf ?? '', xd + 66, y + 43, { tam: 10, negrito: true, larg: 16, alinhar: 'centro' });
  const numero = n.numero ? String(n.numero).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3') : '';
  d.escrever(`Nº ${numero}`, xd, y + 60, { tam: 8, negrito: true, larg: wDanfe, alinhar: 'centro' });
  d.escrever(`SÉRIE ${n.serie ?? ''}`, xd, y + 70, { tam: 8, negrito: true, larg: wDanfe, alinhar: 'centro' });
  folhas.push({ pg: d.pg, x: xd, y: y + 80, w: wDanfe });
  // Chave
  const xc = xd + wDanfe;
  d.ret(xc, y, wChave, 38);
  if (png) {
    const larguraImg = wChave - 12;
    d.pg.drawImage(png, { x: xc + 6, y: A4[1] - y - 34, width: larguraImg, height: 30 });
  }
  d.campo(xc, y + 38, wChave, 22, 'CHAVE DE ACESSO', fmtChave(n.chave), { alinhar: 'centro', negrito: true, tam: 7.5 });
  d.ret(xc, y + 60, wChave, h - 60);
  d.escrever('Consulta de autenticidade no portal nacional da NF-e', xc, y + 66, { tam: 6.5, larg: wChave, alinhar: 'centro' });
  d.escrever('www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora', xc, y + 75, { tam: 6.5, larg: wChave, alinhar: 'centro' });
  d.y = y + h;
  d.linha([
    ['NATUREZA DA OPERAÇÃO', n.natureza_operacao, 60],
    ['PROTOCOLO DE AUTORIZAÇÃO DE USO', [n.protocolo, n.dh_autorizacao ? fmtData(n.dh_autorizacao) : ''].filter(Boolean).join(' - '), 40, { alinhar: 'centro' }],
  ]);
  d.linha([
    ['INSCRIÇÃO ESTADUAL', emit?.ie, 34],
    ['INSC. ESTADUAL DO SUBST. TRIBUTÁRIO', '', 33],
    ['CNPJ / CPF', fmtDoc(n.emit_cnpj), 33],
  ]);
}

const COLS = [
  ['CÓDIGO', 48, 'esq', (i) => i.cprod],
  ['DESCRIÇÃO DO PRODUTO / SERVIÇO', 140, 'esq', null],
  ['NCM/SH', 38, 'centro', (i) => i.ncm],
  ['O/CST', 24, 'centro', (i) => `${i.icms_orig ?? ''}${i.icms_cst ?? ''}`],
  ['CFOP', 22, 'centro', (i) => i.cfop],
  ['UN', 20, 'centro', (i) => i.ucom],
  ['QUANT.', 38, 'dir', (i) => qtd(i.qcom)],
  ['V. UNIT.', 40, 'dir', (i) => num(i.vuncom, i.vuncom != null && Math.round(i.vuncom * 100) !== i.vuncom * 100 ? 4 : 2)],
  ['V. TOTAL', 40, 'dir', (i) => num(i.vprod)],
  ['BC ICMS', 38, 'dir', (i) => num(i.icms_vbc)],
  ['V. ICMS', 32, 'dir', (i) => num(i.icms_vicms)],
  ['V. IPI', 28, 'dir', (i) => num(i.ipi_vipi)],
  ['% ICMS', 24, 'dir', (i) => num(i.icms_picms)],
  ['% IPI', 0, 'dir', (i) => num(i.ipi_pipi)],
];

function cabecalhoItens(d) {
  d.titulo('DADOS DOS PRODUTOS / SERVIÇOS');
  let x = M;
  const usada = COLS.reduce((s, c) => s + c[1], 0);
  COLS.forEach((c) => {
    const w = c[1] || LARG - usada;
    d.ret(x, d.y, w, 14);
    d.escrever(c[0], x + 1, d.y + 4, { tam: 4.8, larg: w - 2, alinhar: 'centro' });
    x += w;
  });
  d.y += 14;
}

function linhaItem(d, it) {
  const wDesc = COLS[1][1] - 4;
  const desc = [it.xprod];
  if (it.inf_ad_prod) desc.push(it.inf_ad_prod);
  const linhas = quebrar(d.f.normal, 6, desc.join(' - '), wDesc, 4);
  const h = Math.max(1, linhas.length) * 7 + 4;
  let x = M;
  const usada = COLS.reduce((s, c) => s + c[1], 0);
  COLS.forEach((c) => {
    const w = c[1] || LARG - usada;
    d.pg.drawLine({ start: { x, y: A4[1] - d.y }, end: { x, y: A4[1] - d.y - h }, thickness: 0.3, color: CINZA });
    if (c[3]) d.escrever(c[3](it), x + 1.5, d.y + 2, { tam: 6, larg: w - 3, alinhar: c[2] });
    else linhas.forEach((l, k) => d.escrever(l, x + 2, d.y + 2 + k * 7, { tam: 6 }));
    x += w;
  });
  d.pg.drawLine({ start: { x: M + LARG, y: A4[1] - d.y }, end: { x: M + LARG, y: A4[1] - d.y - h }, thickness: 0.3, color: CINZA });
  d.pg.drawLine({ start: { x: M, y: A4[1] - d.y - h }, end: { x: M + LARG, y: A4[1] - d.y - h }, thickness: 0.3, color: CINZA });
  d.y += h;
}

function alturaItem(d, it) {
  const desc = [it.xprod, it.inf_ad_prod].filter(Boolean).join(' - ');
  return Math.max(1, quebrar(d.f.normal, 6, desc, COLS[1][1] - 4, 4).length) * 7 + 4;
}

// dados = { n, emit, dest, itens, dups, pags }
export async function gerarDanfe({ n, emit, dest, itens, dups, pags }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(texto(`NF-e ${n.numero || ''} - ${emit?.nome || ''}`));
  pdf.setCreator('Arquivo NF-e');
  const fontes = { normal: await pdf.embedFont(StandardFonts.Helvetica), negrito: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const bar = await codigoDeBarras(n.chave);
  const png = bar ? await pdf.embedPng(bar) : null;
  const d = new Desenho(pdf, fontes);
  const folhas = [];
  const RODAPE = A4[1] - M - 12;

  cabecalho(d, n, emit, png, folhas);

  d.titulo('DESTINATÁRIO / REMETENTE');
  const hs = String(n.dh_saida_entrada || '').match(/T(\d{2}:\d{2}:\d{2})/);
  d.linha([
    ['NOME / RAZÃO SOCIAL', dest?.nome || '', 56],
    ['CNPJ / CPF', fmtDoc(n.dest_cnpj), 26, { alinhar: 'centro' }],
    ['DATA DA EMISSÃO', fmtDataV(n.data_emissao), 18, { alinhar: 'centro' }],
  ]);
  d.linha([
    ['ENDEREÇO', dest ? [dest.logradouro, dest.numero].filter(Boolean).join(', ') + (dest.complemento ? ` - ${dest.complemento}` : '') : '', 46],
    ['BAIRRO / DISTRITO', dest?.bairro, 24],
    ['CEP', dest?.cep, 12, { alinhar: 'centro' }],
    ['DATA DA SAÍDA/ENTRADA', n.dh_saida_entrada ? fmtData(n.dh_saida_entrada.slice(0, 10)) : '', 18, { alinhar: 'centro' }],
  ]);
  d.linha([
    ['MUNICÍPIO', dest?.municipio, 38],
    ['FONE / FAX', dest?.fone, 18],
    ['UF', dest?.uf, 8, { alinhar: 'centro' }],
    ['INSCRIÇÃO ESTADUAL', dest?.ie, 18],
    ['HORA DA SAÍDA/ENTRADA', hs ? hs[1] : '', 18, { alinhar: 'centro' }],
  ]);

  if (dups.length || pags.length || n.fatura_numero) {
    d.titulo('FATURA / DUPLICATAS');
    if (dups.length) {
      const porLinha = 6;
      const w = LARG / porLinha;
      dups.forEach((dp, i) => {
        const x = M + (i % porLinha) * w;
        if (i % porLinha === 0 && i > 0) d.y += 26;
        d.ret(x, d.y, w, 26);
        d.escrever(`Núm.: ${dp.n_dup ?? ''}`, x + 3, d.y + 3, { tam: 6.5, larg: w - 6 });
        d.escrever(`Venc.: ${fmtDataV(dp.vencimento)}`, x + 3, d.y + 10, { tam: 6.5, larg: w - 6 });
        d.escrever(`Valor: R$ ${num(dp.valor)}`, x + 3, d.y + 17, { tam: 6.5, negrito: true, larg: w - 6 });
      });
      d.y += 26;
    } else {
      const fat = n.fatura_numero ? `Fatura ${n.fatura_numero} - valor líquido R$ ${num(n.fatura_v_liq)}` : '';
      const pg = pags.map((p) => `${p.descricao || p.tipo}: R$ ${num(p.valor)}`).join('   ');
      d.linha([['PAGAMENTO', [fat, pg].filter(Boolean).join('   '), 1]], 18);
    }
  }

  d.titulo('CÁLCULO DO IMPOSTO');
  const dir = { alinhar: 'dir' };
  d.linha([
    ['BASE DE CÁLC. DO ICMS', num(n.v_bc), 1, dir], ['VALOR DO ICMS', num(n.v_icms), 1, dir],
    ['BASE DE CÁLC. ICMS S.T.', num(n.v_bcst), 1, dir], ['VALOR DO ICMS SUBST.', num(n.v_st), 1, dir],
    ['V. APROX. TRIBUTOS', num(n.v_tot_trib), 1, dir], ['V. TOTAL PRODUTOS', num(n.v_prod), 1.2, dir],
  ]);
  d.linha([
    ['VALOR DO FRETE', num(n.v_frete), 1, dir], ['VALOR DO SEGURO', num(n.v_seg), 1, dir],
    ['DESCONTO', num(n.v_desc), 1, dir], ['OUTRAS DESPESAS', num(n.v_outro), 1, dir],
    ['VALOR TOTAL IPI', num(n.v_ipi), 1, dir], ['V. TOTAL DA NOTA', num(n.v_nf), 1.2, { alinhar: 'dir', negrito: true }],
  ]);

  d.titulo('TRANSPORTADOR / VOLUMES TRANSPORTADOS');
  d.linha([
    ['NOME / RAZÃO SOCIAL', n.transp_nome, 50],
    ['FRETE POR CONTA', n.mod_frete != null ? `${n.mod_frete} - ${MOD_FRETE[n.mod_frete] || ''}` : '', 30],
    ['CNPJ / CPF', fmtDoc(n.transp_cnpj), 20, { alinhar: 'centro' }],
  ]);
  d.linha([
    ['QUANTIDADE', qtd(n.vol_qtd), 1, dir], ['ESPÉCIE', n.vol_especie, 1.5],
    ['PESO BRUTO', qtd(n.peso_bruto), 1, dir], ['PESO LÍQUIDO', qtd(n.peso_liquido), 1, dir],
  ]);

  cabecalhoItens(d);
  for (const it of itens) {
    if (d.y + alturaItem(d, it) > RODAPE) {
      d.novaPagina();
      cabecalho(d, n, emit, png, folhas);
      cabecalhoItens(d);
    }
    linhaItem(d, it);
  }
  if (!itens.length) d.linha([['', 'Nenhum item', 1]], 16);

  // Dados adicionais
  const adic = [n.inf_complementar, n.inf_fisco ? `Fisco: ${n.inf_fisco}` : ''].filter(Boolean).join(' ');
  const linhasAdic = quebrar(fontes.normal, 6.5, adic, LARG * 0.7 - 6);
  const hAdic = Math.max(50, linhasAdic.length * 8 + 14);
  if (d.y + 10 + hAdic > RODAPE) {
    d.novaPagina();
    cabecalho(d, n, emit, png, folhas);
  }
  d.titulo('DADOS ADICIONAIS');
  d.ret(M, d.y, LARG * 0.7, hAdic);
  d.ret(M + LARG * 0.7, d.y, LARG * 0.3, hAdic);
  d.escrever('INFORMAÇÕES COMPLEMENTARES', M + 2, d.y + 1.5, { tam: 5, cor: CINZA });
  d.escrever('RESERVADO AO FISCO', M + LARG * 0.7 + 2, d.y + 1.5, { tam: 5, cor: CINZA });
  linhasAdic.forEach((l, i) => d.escrever(l, M + 3, d.y + 10 + i * 8, { tam: 6.5 }));

  // Rodapé e numeração das folhas
  const total = d.paginas.length;
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  d.paginas.forEach((pg) => {
    pg.drawText(texto(`Representação gerada a partir do XML da NF-e pelo Arquivo NF-e em ${agora}`), {
      x: M, y: M - 8, size: 5.5, font: fontes.normal, color: CINZA,
    });
  });
  folhas.forEach((f, i) => {
    const t = `FOLHA ${i + 1}/${total}`;
    const w = fontes.normal.widthOfTextAtSize(t, 7);
    f.pg.drawText(t, { x: f.x + (f.w - w) / 2, y: A4[1] - f.y - 7, size: 7, font: fontes.normal, color: PRETO });
  });
  return pdf.save();
}

// Junta vários PDFs (Uint8Array/Buffer) em um único documento.
export async function juntarPdfs(lista) {
  const saida = await PDFDocument.create();
  saida.setTitle('Notas fiscais');
  saida.setCreator('Arquivo NF-e');
  for (const bytes of lista) {
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const paginas = await saida.copyPages(doc, doc.getPageIndices());
      paginas.forEach((p) => saida.addPage(p));
    } catch (e) {
      console.error('[arquivo-nfe] PDF ignorado ao juntar:', e.message);
    }
  }
  return saida.save();
}
