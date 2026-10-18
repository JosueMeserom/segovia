/**
 * Mide la subida a OneDrive con upload sessions de Microsoft Graph.
 *
 *   node tools/medir-subida.mjs --chunk 10 --parallel 4 archivo1 archivo2 ...
 *
 * --chunk en MiB (se redondea a múltiplo de 320 KiB y por debajo de 60 MiB),
 * --parallel = cuántos archivos a la vez. Los trozos de un mismo archivo van
 * siempre en orden: Graph no admite otra cosa.
 *
 * Usa el token que rclone guarda en ~/.config/rclone/rclone.conf (remoto
 * "onedrive"), así no hace falta registrar una app solo para medir. Ejecuta
 * antes cualquier comando de rclone (`rclone about onedrive:`) para que lo
 * refresque. Sube a /Segovia-pruebas y reemplaza lo que haya.
 *
 * --relay URL manda los PUT a ese relevo (un Worker) con la uploadUrl en la
 * cabecera x-upload-url, en lugar de directamente a Microsoft.
 */
import { readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const UNIT = 320 * 1024;
const { values, positionals: files } = parseArgs({
  options: { relay: { type: 'string' }, chunk: { type: 'string', default: '10' }, parallel: { type: 'string', default: '1' } },
  allowPositionals: true,
});
const units = Math.min(Math.max(1, Math.round((Number(values.chunk) * 1024 * 1024) / UNIT)), 191);
const chunk = units * UNIT;

const conf = readFileSync(`${homedir()}/.config/rclone/rclone.conf`, 'utf8');
const section = conf.split(/^\[/m).find((s) => s.startsWith('onedrive]'));
const token = JSON.parse(section.match(/^token = (.*)$/m)[1]).access_token;

async function put(url, buf, start, size) {
  const headers = { 'content-range': `bytes ${start}-${start + buf.length - 1}/${size}` };
  if (values.relay) headers['x-upload-url'] = url;
  for (let i = 0; ; i++) {
    // Un corte de conexión (ECONNRESET) se reintenta igual que un 5xx.
    const r = await fetch(values.relay ?? url, { method: 'PUT', headers, body: buf }).catch((e) => {
      if (i === 4) throw e;
    });
    if (r?.ok) return r.arrayBuffer();
    if (r && (r.status < 500 || i === 4)) throw new Error(`PUT ${r.status}: ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
}

async function upload(path) {
  const { size } = await stat(path);
  const s = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:/Segovia-pruebas/${encodeURIComponent(basename(path))}:/createUploadSession`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    },
  );
  if (!s.ok) throw new Error(`createUploadSession ${s.status}: ${await s.text()}`);
  const { uploadUrl } = await s.json();
  const fh = await open(path);
  try {
    for (let start = 0; start < size; start += chunk) {
      const buf = Buffer.alloc(Math.min(chunk, size - start));
      await fh.read(buf, 0, buf.length, start);
      await put(uploadUrl, buf, start, size);
    }
  } finally {
    await fh.close();
  }
  return size;
}

const queue = [...files];
let total = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    for (let f; (f = queue.shift()); ) {
      const n = await upload(f); // no "total += await …": leería total antes de esperar
      total += n;
    }
  }),
);
const secs = (performance.now() - t0) / 1000;
console.log(
  `chunk=${(chunk / 1048576).toFixed(2)}MiB parallel=${values.parallel} ` +
    `${(total / 1048576).toFixed(0)}MiB en ${secs.toFixed(1)}s = ${(total / 1e6 / secs).toFixed(1)} MB/s`,
);
