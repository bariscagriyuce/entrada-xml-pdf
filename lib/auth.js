// Login com usuário/senha: senha com scrypt, sessão em cookie assinado (HMAC).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';

const DURACAO_MS = 12 * 60 * 60 * 1000; // 12 horas
const COOKIE = 'nfe_sessao';
let segredo;

function obterSegredo() {
  if (segredo) return segredo;
  if (process.env.NFE_SEGREDO) segredo = process.env.NFE_SEGREDO;
  else {
    const arq = path.join(db.DADOS, '.segredo');
    if (!fs.existsSync(arq)) fs.writeFileSync(arq, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    segredo = fs.readFileSync(arq, 'utf8').trim();
  }
  return segredo;
}

export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64);
  return `scrypt$${sal.toString('hex')}$${h.toString('hex')}`;
}

export function conferirSenha(senha, armazenado) {
  const [alg, salHex, hHex] = String(armazenado).split('$');
  if (alg !== 'scrypt' || !salHex || !hHex) return false;
  const h = crypto.scryptSync(senha, Buffer.from(salHex, 'hex'), 64);
  const esperado = Buffer.from(hHex, 'hex');
  return esperado.length === h.length && crypto.timingSafeEqual(esperado, h);
}

const assinar = (txt) => crypto.createHmac('sha256', obterSegredo()).update(txt).digest('base64url');

function lerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

function opcoesCookie(req, maxAgeS) {
  const seguro = req.secure ? '; Secure' : '';
  const caminho = req.app.locals.base || '/';
  return `; Path=${caminho}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${seguro}`;
}

export function iniciarSessao(req, res, usuario) {
  const payload = Buffer.from(JSON.stringify({ u: usuario, exp: Date.now() + DURACAO_MS })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${assinar(payload)}${opcoesCookie(req, DURACAO_MS / 1000)}`);
}

export function encerrarSessao(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${opcoesCookie(req, 0)}`);
}

export function usuarioDaSessao(req) {
  const v = lerCookies(req)[COOKIE];
  if (!v || !v.includes('.')) return null;
  const [payload, sig] = v.split('.');
  const esperado = assinar(payload);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (d.exp < Date.now()) return null;
    return db.get('SELECT id, usuario FROM usuarios WHERE usuario=?', [d.u]) || null;
  } catch {
    return null;
  }
}

// Limite simples de tentativas de login por IP (10 erros em 15 minutos).
const tentativas = new Map();
export function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() - t.inicio > 15 * 60 * 1000) { tentativas.delete(ip); return false; }
  return t.n >= 10;
}
export function registrarFalha(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() - t.inicio > 15 * 60 * 1000) tentativas.set(ip, { n: 1, inicio: Date.now() });
  else t.n += 1;
}
export const limparFalhas = (ip) => tentativas.delete(ip);
