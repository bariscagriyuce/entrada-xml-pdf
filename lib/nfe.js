// Leitura de NF-e / NFC-e (XML modelo 55/65, layout 4.00) da SEFAZ.
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class NaoEhNFe extends Error {}

const LISTAS = new Set(['det', 'dup', 'detPag', 'vol', 'NFref', 'autXML', 'obsCont', 'obsFisco', 'procRef']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (nome) => LISTAS.has(nome),
});

const arvoreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  preserveOrder: true,
});

export const TP_PAG = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de Crédito', '04': 'Cartão de Débito',
  '05': 'Crédito Loja', '10': 'Vale Alimentação', '11': 'Vale Refeição', '12': 'Vale Presente',
  '13': 'Vale Combustível', '15': 'Boleto Bancário', '16': 'Depósito Bancário', '17': 'PIX',
  '18': 'Transferência', '19': 'Fidelidade/Cashback', '90': 'Sem pagamento', '99': 'Outros',
};

// Origem da mercadoria (campo "orig" do ICMS — Tabela A do CST)
export const ORIGEM = {
  '0': 'Nacional, exceto as indicadas nos códigos 3, 4, 5 e 8',
  '1': 'Estrangeira - Importação direta, exceto a indicada no código 6',
  '2': 'Estrangeira - Adquirida no mercado interno, exceto a indicada no código 7',
  '3': 'Nacional, mercadoria ou bem com Conteúdo de Importação superior a 40% e inferior ou igual a 70%',
  '4': 'Nacional, cuja produção tenha sido feita em conformidade com os processos produtivos básicos (PPB)',
  '5': 'Nacional, mercadoria ou bem com Conteúdo de Importação inferior ou igual a 40%',
  '6': 'Estrangeira - Importação direta, sem similar nacional, constante em lista da CAMEX e gás natural',
  '7': 'Estrangeira - Adquirida no mercado interno, sem similar nacional, constante em lista da CAMEX e gás natural',
  '8': 'Nacional, mercadoria ou bem com Conteúdo de Importação superior a 70%',
};

export const ORIGEM_CURTA = {
  '0': 'Nacional',
  '1': 'Estrangeira - importação direta',
  '2': 'Estrangeira - mercado interno',
  '3': 'Nacional - CI > 40% e ≤ 70%',
  '4': 'Nacional - PPB',
  '5': 'Nacional - CI ≤ 40%',
  '6': 'Estrangeira - importação direta, sem similar (CAMEX)',
  '7': 'Estrangeira - mercado interno, sem similar (CAMEX)',
  '8': 'Nacional - CI > 70%',
};

export const MOD_FRETE = {
  '0': 'Por conta do emitente (CIF)', '1': 'Por conta do destinatário (FOB)',
  '2': 'Por conta de terceiros', '3': 'Transporte próprio (remetente)',
  '4': 'Transporte próprio (destinatário)', '9': 'Sem frete',
};

function texto(buf) {
  let s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

// caminho "a/b/c" dentro do objeto
function no(obj, caminho) {
  let cur = obj;
  for (const p of caminho.split('/')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[0] : cur;
    cur = cur[p];
  }
  return Array.isArray(cur) ? cur[0] : cur;
}

function t(obj, caminho) {
  const v = no(obj, caminho);
  if (v == null) return null;
  const s = typeof v === 'object' ? v['#text'] : v;
  if (s == null) return null;
  const r = String(s).trim();
  return r === '' ? null : r;
}

function f(obj, caminho) {
  const v = t(obj, caminho);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function primeiroFilho(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@') || k === '#text') continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

function acharChave(obj, chave) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const x of obj) { const r = acharChave(x, chave); if (r) return r; }
    return null;
  }
  if (obj[chave] !== undefined) return Array.isArray(obj[chave]) ? obj[chave][0] : obj[chave];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) continue;
    const r = acharChave(v, chave);
    if (r) return r;
  }
  return null;
}

function endereco(el) {
  if (!el) return {};
  return {
    logradouro: t(el, 'xLgr'), numero: t(el, 'nro'), complemento: t(el, 'xCpl'),
    bairro: t(el, 'xBairro'), municipio: t(el, 'xMun'), uf: t(el, 'UF'), cep: t(el, 'CEP'),
    fone: t(el, 'fone'),
  };
}

function pessoa(el, enderTag) {
  if (!el) return {};
  return {
    cnpj: t(el, 'CNPJ') || t(el, 'CPF') || t(el, 'idEstrangeiro'),
    nome: t(el, 'xNome'), fantasia: t(el, 'xFant'), ie: t(el, 'IE'), crt: t(el, 'CRT'),
    email: t(el, 'email'),
    ...endereco(el[enderTag]),
  };
}

function item(det) {
  const prod = det.prod || {};
  const imp = det.imposto || {};
  const icms = primeiroFilho(imp.ICMS);
  const ipiTrib = imp.IPI ? imp.IPI.IPITrib : null;
  const ipiNt = imp.IPI ? imp.IPI.IPINT : null;
  const pis = primeiroFilho(imp.PIS);
  const cofins = primeiroFilho(imp.COFINS);
  return {
    n_item: parseInt(det['@nItem'] || '0', 10),
    cprod: t(prod, 'cProd'), cean: t(prod, 'cEAN'), xprod: t(prod, 'xProd'),
    ncm: t(prod, 'NCM'), cest: t(prod, 'CEST'), cfop: t(prod, 'CFOP'),
    ucom: t(prod, 'uCom'), qcom: f(prod, 'qCom'), vuncom: f(prod, 'vUnCom'), vprod: f(prod, 'vProd'),
    utrib: t(prod, 'uTrib'), qtrib: f(prod, 'qTrib'), vuntrib: f(prod, 'vUnTrib'),
    vfrete: f(prod, 'vFrete'), vseg: f(prod, 'vSeg'), vdesc: f(prod, 'vDesc'), voutro: f(prod, 'vOutro'),
    xped: t(prod, 'xPed'), nitemped: t(prod, 'nItemPed'),
    icms_orig: t(icms, 'orig'), icms_cst: t(icms, 'CST') || t(icms, 'CSOSN'),
    icms_vbc: f(icms, 'vBC'), icms_picms: f(icms, 'pICMS'), icms_vicms: f(icms, 'vICMS'),
    icms_vbcst: f(icms, 'vBCST'), icms_vicmsst: f(icms, 'vICMSST'),
    ipi_cst: t(ipiTrib, 'CST') || t(ipiNt, 'CST'), ipi_pipi: f(ipiTrib, 'pIPI'), ipi_vipi: f(ipiTrib, 'vIPI'),
    pis_cst: t(pis, 'CST'), pis_vpis: f(pis, 'vPIS'),
    cofins_cst: t(cofins, 'CST'), cofins_vcofins: f(cofins, 'vCOFINS'),
    vtottrib: f(imp, 'vTotTrib'), inf_ad_prod: t(det, 'infAdProd'),
  };
}

export function parseNFe(buf) {
  const xml = texto(buf);
  const val = XMLValidator.validate(xml);
  if (val !== true) throw new NaoEhNFe(`XML inválido: ${val.err ? val.err.msg : 'erro de sintaxe'}`);
  const root = parser.parse(xml);
  const inf = acharChave(root, 'infNFe');
  if (!inf) {
    const raiz = Object.keys(root).find((k) => !k.startsWith('?')) || '?';
    throw new NaoEhNFe(`O arquivo não é uma NF-e (elemento raiz: ${raiz})`);
  }
  const prot = acharChave(root, 'infProt');
  let chave = (inf['@Id'] || '').replace(/^NFe/, '') || null;
  if (!chave && prot) chave = t(prot, 'chNFe');

  const ide = inf.ide || {};
  const tot = no(inf, 'total/ICMSTot') || {};
  const transp = inf.transp || {};
  const transporta = transp.transporta || null;
  const vol = Array.isArray(transp.vol) ? transp.vol[0] : null;
  const dh = t(ide, 'dhEmi') || t(ide, 'dEmi');
  const cobr = inf.cobr || {};

  const nota = {
    chave,
    numero: t(ide, 'nNF'), serie: t(ide, 'serie'), modelo: t(ide, 'mod'),
    data_emissao: dh ? dh.slice(0, 10) : null, dh_emissao: dh,
    dh_saida_entrada: t(ide, 'dhSaiEnt') || t(ide, 'dSaiEnt'),
    natureza_operacao: t(ide, 'natOp'), tipo_nf: t(ide, 'tpNF'), finalidade: t(ide, 'finNFe'),
    uf_codigo: t(ide, 'cUF'), ambiente: t(ide, 'tpAmb'),
    v_bc: f(tot, 'vBC'), v_icms: f(tot, 'vICMS'), v_bcst: f(tot, 'vBCST'), v_st: f(tot, 'vST'),
    v_prod: f(tot, 'vProd'), v_frete: f(tot, 'vFrete'), v_seg: f(tot, 'vSeg'), v_desc: f(tot, 'vDesc'),
    v_ipi: f(tot, 'vIPI'), v_pis: f(tot, 'vPIS'), v_cofins: f(tot, 'vCOFINS'), v_outro: f(tot, 'vOutro'),
    v_nf: f(tot, 'vNF'), v_tot_trib: f(tot, 'vTotTrib'),
    mod_frete: t(transp, 'modFrete'),
    transp_cnpj: t(transporta, 'CNPJ') || t(transporta, 'CPF'), transp_nome: t(transporta, 'xNome'),
    vol_qtd: f(vol, 'qVol'), vol_especie: t(vol, 'esp'),
    peso_liquido: f(vol, 'pesoL'), peso_bruto: f(vol, 'pesoB'),
    inf_complementar: t(inf, 'infAdic/infCpl'), inf_fisco: t(inf, 'infAdic/infAdFisco'),
    protocolo: t(prot, 'nProt'), status_codigo: t(prot, 'cStat'), status_motivo: t(prot, 'xMotivo'),
    dh_autorizacao: t(prot, 'dhRecbto'),
    fatura_numero: t(cobr, 'fat/nFat'), fatura_v_liq: f(cobr, 'fat/vLiq'),
  };

  const itens = (inf.det || []).map(item);
  const duplicatas = (cobr.dup || []).map((d) => ({ n_dup: t(d, 'nDup'), vencimento: t(d, 'dVenc'), valor: f(d, 'vDup') }));
  const pagamentos = ((inf.pag && inf.pag.detPag) || []).map((p) => {
    const tp = t(p, 'tPag');
    return { tipo: tp, descricao: TP_PAG[tp] || t(p, 'xPag') || tp, valor: f(p, 'vPag') };
  });

  return {
    nota,
    emitente: pessoa(inf.emit, 'enderEmit'),
    destinatario: pessoa(inf.dest, 'enderDest'),
    itens, duplicatas, pagamentos,
  };
}

// Árvore completa do XML (sem a assinatura digital), para exibição.
export function xmlParaArvore(buf) {
  const lista = arvoreParser.parse(texto(buf));
  const conv = (entrada) => {
    const nome = Object.keys(entrada).find((k) => k !== ':@');
    const attrs = {};
    for (const [k, v] of Object.entries(entrada[':@'] || {})) attrs[k.replace(/^@/, '')] = v;
    let txt = '';
    const filhos = [];
    for (const c of entrada[nome] || []) {
      if (c['#text'] !== undefined) txt += String(c['#text']);
      else {
        const n = Object.keys(c).find((k) => k !== ':@');
        if (n && n !== 'Signature') filhos.push(conv(c));
      }
    }
    return { tag: nome, texto: txt.trim(), attrs, filhos };
  };
  const raiz = lista.find((e) => !Object.keys(e)[0].startsWith('?'));
  return raiz ? conv(raiz) : null;
}
