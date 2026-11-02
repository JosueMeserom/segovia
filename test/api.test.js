import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'segovia-'));
process.env.SEGOVIA_DIR = dir;
process.env.ONEDRIVE_CLIENT_ID = 'cliente';
process.env.PUBLIC_BASE_URL = 'https://s.example';
const { api, segmentos, refRuta, firmar, tipoDe, vigilado, red, aprender, elegirIp } = await import('../src/api.js');
const { guardar, leer, renovar } = await import('../src/graph.js');

const hash = (c) => createHash('sha256').update(c).digest('hex');
const RAIZ = { drive: 'D1', item: 'R!1' };
const url = (exp) => `https://my.microsoftpersonalcontent.com/x?tempauth=a.${btoa(JSON.stringify({ exp }))}.c`;
const futuro = () => Math.floor(Date.now() / 1000) + 3600;

before(() => {
  guardar('sesion.json', { refresh_token: 'r0' });
  guardar('config.json', { raiz: RAIZ, firma: 'secreto', clientes: { lee: { hash: hash('clave-lee') }, sube: { hash: hash('clave-sube'), escribe: true } } });
});

/** Sustituye fetch: da tokens y delega el resto en `fn`. */
function falso(t, fn) {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const llamadas = [];
  // Lo que iría a los servidores de descarga pasa por `red`: aquí, por el mismo sitio que lo demás.
  red.pedir = ({ url: u, ...op }) => globalThis.fetch(u, op);
  globalThis.fetch = async (u, op = {}) => {
    u = String(u);
    llamadas.push({ url: u, op });
    if (u.includes('/oauth2/v2.0/token'))
      return Response.json({ access_token: 'acceso', refresh_token: 'r' + llamadas.length, expires_in: 3600 });
    return fn(u, op);
  };
  return llamadas;
}
const pide = (ruta, op = {}) => api(new Request('https://s.example' + ruta, op));
const conClave = (c, op = {}) => ({ ...op, headers: { authorization: 'Bearer ' + c, ...op.headers } });

test('rutas: no se sale de la raíz y se codifica cada trozo', () => {
  assert.deepEqual(segmentos('a//b/'), ['a', 'b']);
  for (const r of ['..', 'a/../b', './a', 'a\\b']) assert.throws(() => segmentos(r), { status: 400 }, r);
  assert.equal(refRuta(RAIZ, ''), '/drives/D1/items/R!1');
  assert.equal(refRuta(RAIZ, "Vídeos/Schindler's #1 100%.mkv"), "/drives/D1/items/R!1:/V%C3%ADdeos/Schindler's%20%231%20100%25.mkv:");
});

test('tipo: la extensión manda sobre lo que diga Microsoft', () => {
  assert.equal(tipoDe('a.MKV', 'application/octet-stream'), 'video/x-matroska');
  assert.equal(tipoDe('a.bin', 'application/zip'), 'application/zip');
  assert.equal(tipoDe('a', undefined), 'application/octet-stream');
});

test('claves: sin clave 401, y una de lectura no puede subir', async () => {
  assert.equal((await pide('/api/lista')).status, 401);
  assert.equal((await pide('/api/lista', conClave('mala'))).status, 401);
  const r = await pide('/api/subida', conClave('clave-lee', { method: 'POST', body: '{"ruta":"a.mkv","tamano":1}' }));
  assert.equal(r.status, 403);
});

test('sesión: el refresh token nuevo se guarda atómico y con permisos 600', async (t) => {
  falso(t, () => new Response(null, { status: 500 }));
  await renovar();
  assert.notEqual(leer('sesion.json').refresh_token, 'r0');
  assert.equal(statSync(join(dir, 'sesion.json')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(dir, 'sesion.json.tmp')));
});

test('sesión: si Microsoft la rechaza se avisa una sola vez, y otra al volver', async (t) => {
  const f = join(dir, 'avisos.txt');
  process.env.AVISO_CMD = `printf '%s\\n' >> ${f}`;
  t.after(() => delete process.env.AVISO_CMD);
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const antes = leer('sesion.json');
  globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(renovar());
  await assert.rejects(renovar());
  assert.deepEqual(leer('sesion.json'), antes, 'un fallo no borra el token guardado');
  globalThis.fetch = async () => Response.json({ access_token: 'a', refresh_token: 'nuevo', expires_in: 3600 });
  await renovar();
  await new Promise((ok) => setTimeout(ok, 200));
  const avisos = readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(avisos.length, 2);
  assert.match(avisos[0], /invalid_grant/);
  assert.match(avisos[1], /vuelve/);
});

test('graph: con un 401 renueva el token y repite una sola vez; un 429 espera lo que diga Microsoft', async (t) => {
  const respuestas = [new Response(null, { status: 401 }), new Response(null, { status: 429, headers: { 'retry-after': '0.01' } }), Response.json({ ok: 1 })];
  const llamadas = falso(t, () => respuestas.shift());
  const { graph } = await import('../src/graph.js');
  assert.deepEqual(await (await graph('/me')).json(), { ok: 1 });
  assert.equal(llamadas.filter((l) => l.url.includes('/token')).length, 1);
  const siempre = falso(t, () => new Response(null, { status: 401 }));
  assert.equal((await graph('/me')).status, 401);
  assert.equal(siempre.filter((l) => l.url.includes('/me')).length, 2);
});

test('servir: firma mala 403; rango e inline con el tipo de MKV', async (t) => {
  const id = 'CID!sabc';
  falso(t, (u, op) => {
    if (u.includes('graph.microsoft.com')) return Response.json({ name: 'Capítulo 1.mkv', file: { mimeType: 'application/octet-stream' }, '@microsoft.graph.downloadUrl': url(futuro()) });
    assert.equal(op.headers.range, 'bytes=10-19');
    return new Response('0123456789', { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 10-19/100', 'content-length': '10', 'accept-ranges': 'bytes', 'content-disposition': 'attachment' } });
  });
  assert.equal((await pide(`/id/${id}/${'x'.repeat(43)}/a.mkv`)).status, 403);
  assert.equal((await pide(`/id/otro/${firmar('secreto', id)}/a.mkv`)).status, 403, 'la firma vale para un solo archivo');
  const r = await pide(`/id/${encodeURIComponent(id)}/${firmar('secreto', id)}/a.mkv`, { headers: { range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/x-matroska');
  assert.equal(r.headers.get('content-range'), 'bytes 10-19/100');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(r.headers.get('content-disposition'), /^inline/);
  assert.equal(await r.text(), '0123456789');
});

test('servir: si la URL caduca, se pide otra y se repite el mismo rango; también por el modo de prueba', async (t) => {
  const id = 'CID!scaduca';
  let pedidas = 0;
  const rangos = [];
  falso(t, (u, op) => {
    if (u.includes('graph.microsoft.com')) {
      pedidas++;
      return Response.json({ name: 'a.mkv', '@microsoft.graph.downloadUrl': url(futuro()) + '&n=' + pedidas });
    }
    rangos.push(op.headers.range);
    if (u.includes('caducado') || u.includes('n=1') && rangos.length === 1) return new Response('caducada', { status: 401 });
    return new Response('ok', { status: 206, headers: { 'content-range': 'bytes 5-6/9' } });
  });
  const ruta = `/id/${id}/${firmar('secreto', id)}/a.mkv`;
  const r1 = await pide(ruta, { headers: { range: 'bytes=5-6' } });
  assert.equal(r1.status, 206);
  assert.equal(pedidas, 2);
  assert.deepEqual(rangos, ['bytes=5-6', 'bytes=5-6']);

  const c = await pide('/api/pruebas/caducar', conClave('clave-lee', { method: 'POST', body: JSON.stringify({ id }) }));
  assert.deepEqual(await c.json(), { caducados: 1 });
  const r2 = await pide(ruta, { headers: { range: 'bytes=5-6' } });
  assert.equal(r2.status, 206);
  assert.equal(pedidas, 3, 'el modo de prueba pasa por la renovación real');
});

test('servir: varias peticiones a la vez piden la URL una sola vez, y ?m=redirect no pasa bytes', async (t) => {
  const id = 'CID!svarias';
  let pedidas = 0;
  const llamadas = falso(t, async (u) => {
    if (u.includes('graph.microsoft.com')) {
      pedidas++;
      await new Promise((ok) => setTimeout(ok, 20));
      return Response.json({ name: 'a.mkv', '@microsoft.graph.downloadUrl': url(futuro()) });
    }
    return new Response('x', { status: 200 });
  });
  const ruta = `/id/${id}/${firmar('secreto', id)}/a.mkv`;
  await Promise.all([pide(ruta), pide(ruta), pide(ruta)]);
  assert.equal(pedidas, 1);
  const n = llamadas.length;
  const r = await pide(ruta + '?m=redirect');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /microsoftpersonalcontent/);
  assert.equal(llamadas.length, n, 'el redirect no toca a Microsoft');
});

test('listar: recorre subcarpetas y devuelve URL firmadas', async (t) => {
  falso(t, (u) => {
    if (u.includes('/children') && u.includes(':/Series/T:')) return Response.json({ value: [{ id: 'CID!sv', name: 'S01E01.mkv', size: 5, file: {}, description: 'alto=1080' }] });
    if (u.includes('/children')) return Response.json({ value: [{ id: 'CID!sc', name: 'T', folder: {} }] });
    return new Response(null, { status: 500 });
  });
  const r = await (await pide('/api/lista?ruta=Series&profundo=1', conClave('clave-lee'))).json();
  assert.deepEqual(r.carpetas.map((c) => c.ruta), ['Series/T']);
  const [a] = r.archivos;
  assert.equal(a.ruta, 'Series/T/S01E01.mkv');
  assert.equal(a.descripcion, 'alto=1080');
  assert.equal(a.url, `https://s.example/id/CID!sv/${firmar('secreto', 'CID!sv')}/S01E01.mkv`);
});

test('subida: da la uploadUrl sin subir nada, y avisa si no cabe', async (t) => {
  let libre = 100;
  let cuerpo;
  falso(t, (u, op) => {
    if (u.includes('quota')) return Response.json({ quota: { remaining: libre } });
    cuerpo = JSON.parse(op.body);
    return Response.json({ uploadUrl: 'https://u.example/s', expirationDateTime: '2030-01-01T00:00:00Z' });
  });
  const pedir = (b) => pide('/api/subida', conClave('clave-sube', { method: 'POST', body: JSON.stringify(b) }));
  assert.equal((await pedir({ ruta: 'a.mkv', tamano: 200 })).status, 507);
  libre = 500;
  const r = await pedir({ ruta: 'a.mkv', tamano: 200 });
  assert.deepEqual(await r.json(), { uploadUrl: 'https://u.example/s', caduca: '2030-01-01T00:00:00Z' });
  assert.equal(cuerpo.item['@microsoft.graph.conflictBehavior'], 'fail');
  await pedir({ ruta: 'a.mkv', tamano: 200, reemplazar: true });
  assert.equal(cuerpo.item['@microsoft.graph.conflictBehavior'], 'replace');
  assert.equal((await pedir({ ruta: '../a.mkv', tamano: 1 })).status, 400);
});

// ── Conexión vigilada ────────────────────────────────────────────────────────

/** Un cuerpo de Microsoft: da `trozos` con `pausa` ms entre uno y otro; `corte` lanza un error al acabar. */
function cuerpoFalso(trozos, pausa = 0, corte = null) {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (pausa) await new Promise((ok) => setTimeout(ok, pausa));
      if (i < trozos.length) return c.enqueue(new TextEncoder().encode(trozos[i++]));
      if (corte) return c.error(corte);
      c.close();
    },
  });
}
const parcial = (body, inicio, fin) => new Response(body, { status: 206, headers: { 'content-range': `bytes ${inicio}-${fin}/100` } });

test('vigilado: si se corta, sigue desde el byte exacto y el reproductor recibe todo seguido', async () => {
  const rangos = [];
  const primera = parcial(cuerpoFalso(['abc', 'de'], 0, new Error('ECONNRESET')), 10, 19);
  const abrir = async (r) => (rangos.push(r), parcial(cuerpoFalso(['fghij']), 15, 19));
  const texto = await new Response(vigilado(primera, abrir, 10, 19)).text();
  assert.equal(texto, 'abcdefghij');
  assert.deepEqual(rangos, ['bytes=15-19']);
});

test('vigilado: si acaba antes de tiempo también retoma; si no le dan el rango pedido, falla sin inventar bytes', async () => {
  const abrir = async () => parcial(cuerpoFalso(['xyz']), 3, 5);
  assert.equal(await new Response(vigilado(parcial(cuerpoFalso(['abc']), 0, 5), abrir, 0, 5)).text(), 'abcxyz');
  const mal = async () => new Response('todo', { status: 200 });
  await assert.rejects(new Response(vigilado(parcial(cuerpoFalso(['abc']), 0, 5), mal, 0, 5)).text());
  const otro = async () => parcial(cuerpoFalso(['z']), 4, 5);
  await assert.rejects(new Response(vigilado(parcial(cuerpoFalso(['abc']), 0, 5), otro, 0, 5)).text());
});

test('vigilado: una conexión lenta se cambia por otra desde el mismo byte', async () => {
  const lentos = Array.from({ length: 200 }, () => 'x');
  const rangos = [];
  const primera = parcial(cuerpoFalso(lentos, 5), 0, 299);
  const abrir = async (r) => {
    rangos.push(r);
    const desde = Number(r.match(/=(\d+)/)[1]);
    return parcial(cuerpoFalso(['y'.repeat(300 - desde)]), desde, 299);
  };
  const texto = await new Response(vigilado(primera, abrir, 0, 299, { minBps: 1e6, ventana: 30 })).text();
  assert.equal(texto.length, 300);
  assert.equal(rangos.length, 1);
  assert.match(texto, /^x+y+$/);
});

test('vigilado: un reproductor que lee despacio no provoca cambios', async () => {
  let cambios = 0;
  const primera = parcial(cuerpoFalso(['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)]), 0, 2999);
  const lector = vigilado(primera, async () => (cambios++, parcial(cuerpoFalso([]), 0, 0)), 0, 2999, { minBps: 1e6, ventana: 30 }).getReader();
  let n = 0;
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 40)); // más que la ventana, pero sin que Microsoft tenga la culpa
    const { done, value } = await lector.read();
    if (done) break;
    n += value.length;
  }
  assert.equal(n, 3000);
  assert.equal(cambios, 0);
});

test('vigilado: sin datos en el plazo cambia de conexión; tras varios intentos seguidos, falla', async () => {
  const colgado = () => new ReadableStream({ pull: () => new Promise(() => {}) });
  let intentos = 0;
  const abrir = async (r) => (intentos++, parcial(colgado(), Number(r.match(/=(\d+)/)[1]), 9));
  await assert.rejects(new Response(vigilado(parcial(colgado(), 0, 9), abrir, 0, 9, { plazo: 10 })).text(), /no da datos/);
  assert.equal(intentos, 3);
});

test('elegir servidor: evita los lentos, se queda con el rápido y pide otra opinión si solo le dan lentos', () => {
  aprender('9.9.9.9', { lenta: true });
  assert.equal(elegirIp(['9.9.9.9']), null, 'si todo está marcado, hay que preguntar a otro');
  assert.equal(elegirIp(['9.9.9.9', '8.8.4.4']), '8.8.4.4');
  aprender('7.7.7.7', { rapida: true });
  assert.equal(elegirIp(['9.9.9.9']), '7.7.7.7', 'el que ha ido bien gana aunque el DNS no lo dé');
  aprender('7.7.7.7', { lenta: true });
  assert.equal(elegirIp(['7.7.7.7']), null, 'deja de ser bueno en cuanto va mal');
  aprender('7.7.7.7', { rapida: true });
  assert.equal(elegirIp([]), '7.7.7.7', 'y vuelve si se recupera');
  aprender('7.7.7.7', { lenta: true });
  aprender(undefined, { rapida: true });
});

test('vigilado: enseña qué servidor es lento y cuál rápido', async () => {
  const fuera = 'test-' + Math.random();
  const primera = Object.assign(parcial(cuerpoFalso(Array.from({ length: 100 }, () => 'x'), 5), 0, 199), { ip: fuera });
  const abrir = async (r) => {
    const d = Number(r.match(/=(\d+)/)[1]);
    return Object.assign(parcial(cuerpoFalso(['y'.repeat(200 - d)]), d, 199), { ip: 'otra' });
  };
  await new Response(vigilado(primera, abrir, 0, 199, { minBps: 1e6, ventana: 30 })).text();
  assert.equal(elegirIp([fuera]), null, 'el lento queda marcado');
});

test('vigilado: si el reproductor se va no reconecta', async () => {
  const ac = new AbortController();
  let cambios = 0;
  const primera = parcial(new ReadableStream({ pull: (c) => (ac.abort(), c.error(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))) }), 0, 9);
  await assert.rejects(new Response(vigilado(primera, async () => (cambios++, parcial(cuerpoFalso([]), 0, 0)), 0, 9, { signal: ac.signal })).text());
  assert.equal(cambios, 0);
});
