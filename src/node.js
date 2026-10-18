/**
 * Adaptador de Node: sirve el núcleo con node:http, sin frameworks.
 *
 *   node --env-file-if-exists=.env src/node.js
 *
 * Aquí sí funcionan los dos modos, redirect y proxy. La landing la sirve el
 * propio proceso, para que Caddy solo tenga que hacer reverse_proxy.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { handle } from './core.js';

const { HOST = '127.0.0.1', PORT = '4040', PUBLIC_BASE_URL } = process.env;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/enlace.js': ['enlace.js', 'text/javascript; charset=utf-8'],
  '/subir.js': ['subir.js', 'text/javascript; charset=utf-8'],
};
for (const v of Object.values(STATIC)) v[0] = readFileSync(new URL('../landing/' + v[0], import.meta.url));

// La subida solo aparece si hay app de Microsoft: su client ID (público, va al
// navegador igualmente) y el relevo se meten en la landing al arrancar.
const { ONEDRIVE_CLIENT_ID, RELAY_URL } = process.env;
if (ONEDRIVE_CLIENT_ID) {
  const config = JSON.stringify({ clientId: ONEDRIVE_CLIENT_ID, relay: RELAY_URL }).replace(/</g, '\\u003c');
  STATIC['/'][0] = String(STATIC['/'][0]).replace('<script id="config" type="application/json">{}', '<script id="config" type="application/json">' + config);
}

createServer(async (req, res) => {
  // Detrás de Caddy llega por http: la URL pública (https) se toma de la config.
  const url = new URL(req.url, PUBLIC_BASE_URL ?? `http://${req.headers.host}`);
  const file = STATIC[url.pathname];
  if (file) {
    res.writeHead(200, { 'content-type': file[1] });
    return res.end(file[0]);
  }

  // Si quien pide se va (cierra el vídeo, salta a otro punto), se corta también la descarga a Microsoft.
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = {};
  for (const k of ['user-agent', 'range', 'if-range']) if (req.headers[k]) headers[k] = req.headers[k];

  const r = await handle(new Request(url, { method: req.method, headers, signal: ac.signal }), process.env).catch((e) => {
    console.error(e);
    return new Response('Error interno.\n', { status: 500 });
  });
  res.on('close', () => {
    const ua = (req.headers['user-agent'] ?? '-').slice(0, 60);
    console.log(`${req.method} ${url.pathname.slice(0, 40)}${url.search} ${r.status} ${req.headers.range ?? ''} ${res.writableFinished ? '' : 'cortada '}"${ua}"`);
  });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(r.body)
    .on('error', () => res.destroy())
    .pipe(res);
}).listen(Number(PORT), HOST, () => console.log(`Segovia en http://${HOST}:${PORT}`));
