/**
 * Sesión de Microsoft del dueño de la instancia. Solo la usa el adaptador de
 * Node: el token nunca llega al Worker ni sale por la API.
 *
 * El refresh token rota: cada renovación devuelve uno nuevo, y si no se guarda,
 * un día deja de funcionar sin avisar. Por eso se escribe en disco antes de usar
 * el access token, de forma atómica, y se renueva también sin tráfico (caduca
 * tras meses sin uso, y así un fallo se avisa antes de que alguien lo sufra).
 */
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// `.All` hace falta para entrar en carpetas compartidas por otra cuenta.
export const SCOPE = 'Files.ReadWrite.All offline_access';

const dir = () => process.env.SEGOVIA_DIR ?? join(homedir(), '.config/segovia');

/** @returns {any} el JSON de ~/.config/segovia, o null si no existe */
export function leer(nombre) {
  try {
    return JSON.parse(readFileSync(join(dir(), nombre), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Escritura atómica: un corte a medias deja el archivo anterior entero, nunca uno roto. */
export function guardar(nombre, datos) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const final = join(dir(), nombre);
  const fd = openSync(final + '.tmp', 'w', 0o600);
  writeSync(fd, JSON.stringify(datos, null, 1));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(final + '.tmp', final);
}

/** Manda el aviso con AVISO_CMD, que recibe el texto como último argumento. */
function avisar(texto) {
  console.error(texto);
  const cmd = process.env.AVISO_CMD;
  if (cmd) execFile('sh', ['-c', `${cmd} "$1"`, 'segovia', texto], (e) => e && console.error('El aviso ha fallado:', e.message));
}

let acceso = null; // { token, exp }
let renovando = null;
let fallos = 0;
let avisado = false;

async function pedirToken() {
  const s = leer('sesion.json');
  if (!s?.refresh_token) throw Object.assign(new Error('no hay sesión'), { grave: true });
  const r = await fetch(AUTH + 'token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.ONEDRIVE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: s.refresh_token,
      scope: SCOPE,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? `Microsoft responde ${r.status}`), { grave: r.status < 500 && r.status !== 429 });
  guardar('sesion.json', { refresh_token: d.refresh_token ?? s.refresh_token, renovado: new Date().toISOString() });
  acceso = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
}

/** Renueva una sola vez aunque lo pidan varios a la vez, y avisa si falla: enseguida si es definitivo, a la segunda si puede ser la red. */
export function renovar() {
  renovando ??= pedirToken()
    .then(() => {
      if (avisado) avisar('Segovia: la sesión de Microsoft vuelve a funcionar.');
      fallos = 0;
      avisado = false;
    })
    .catch((e) => {
      fallos++;
      if (!avisado && (e.grave || fallos >= 2)) {
        avisado = true;
        avisar(`Segovia: no se puede renovar la sesión de Microsoft (${e.message}). El servido por ID dejará de funcionar. Si no se arregla sola: npm run segovia login`);
      }
      throw e;
    })
    .finally(() => (renovando = null));
  return renovando;
}

/** Renovación periódica; si falla, reintenta cada 10 min hasta que vuelva. */
export function vigilar() {
  const tic = () =>
    renovar().then(
      () => setTimeout(tic, 12 * 3600e3).unref(),
      () => setTimeout(tic, 10 * 60e3).unref(),
    );
  tic();
}

async function token(forzar) {
  if (forzar || !acceso || acceso.exp - 5 * 60e3 < Date.now()) await renovar();
  return acceso.token;
}

/** Petición a Graph: renueva el token con un 401 y espera lo que Microsoft pida con un 429 o un 503. */
export async function graph(ruta, opciones = {}) {
  const url = ruta.startsWith('https://') ? ruta : GRAPH + ruta;
  let forzar = false;
  let forzado = false;
  for (let i = 0; ; i++) {
    const r = await fetch(url, { ...opciones, headers: { ...opciones.headers, authorization: 'Bearer ' + (await token(forzar)) } });
    forzar = false;
    if (r.status === 401 && !forzado) {
      await r.body?.cancel();
      forzar = forzado = true;
      continue;
    }
    if ((r.status === 429 || r.status === 503) && i < 3) {
      await r.body?.cancel();
      const espera = Math.min(Number(r.headers.get('retry-after')) || 2 ** i, 30);
      await new Promise((ok) => setTimeout(ok, espera * 1000));
      continue;
    }
    return r;
  }
}
