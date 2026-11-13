import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPath, fromPath, esEmpresa } from '../landing/enlace.js';
import { pickMode, kindOf, proxyHeaders, tempauthExp, isBot, handle } from '../src/core.js';
import { relay, relayTarget } from '../src/relay.js';
import { partes, nombreParte, esperado, carpeta, sinRepetir, deBusqueda, unidadDe } from '../landing/subir.js';

const CID = 'https://1drv.ms/v/c/8cf2e82e4f98b498/IQCpdMbCZGm7QbdveSe-zYVHAVZFVCCJrejuHQD7SRE58Z8';

test('enlaces: 1drv.ms se queda con el mismo path y sin ?e=', () => {
  assert.equal(toPath(CID + '?e=urd1Zz'), '/v/c/8cf2e82e4f98b498/IQCpdMbCZGm7QbdveSe-zYVHAVZFVCCJrejuHQD7SRE58Z8');
  assert.equal(fromPath(toPath(CID + '?e=urd1Zz')), CID);
  assert.equal(fromPath(toPath('https://1drv.ms/i/s!AphAbc-_9')), 'https://1drv.ms/i/s!AphAbc-_9');
});

test('enlaces: onedrive.live.com va entero en base64url y vuelve igual', () => {
  const l = 'https://onedrive.live.com/?cid=ABC&resid=ABC%21123&authkey=!xyz';
  const p = toPath(l);
  assert.match(p, /^\/u\/[\w-]+$/);
  assert.equal(fromPath(p), l);
});

test('enlaces: se rechaza lo que no es OneDrive personal', () => {
  for (const l of ['no es url', 'https://example.com/v/c/1/2', 'https://1drv.ms/', 'https://empresa-my.sharepoint.com/:v:/g/x'])
    assert.equal(toPath(l), null, l);
  for (const p of ['/', '/v/c/zz/1', '/u/' + btoa('https://evil.example/'), '/u/%%%', '/raw'])
    assert.equal(fromPath(p), null, p);
  assert.ok(esEmpresa('empresa-my.sharepoint.com'));
  assert.ok(!esEmpresa('1drv.ms'));
});

test('modo: ?m= gana, luego DEFAULT_MODE, luego redirect', () => {
  const u = (q) => new URL('https://s.example/v/c/1/a' + q);
  assert.equal(pickMode(u('?m=proxy'), { DEFAULT_MODE: 'redirect' }), 'proxy');
  assert.equal(pickMode(u('?m=redirect'), { DEFAULT_MODE: 'proxy' }), 'redirect');
  assert.equal(pickMode(u(''), { DEFAULT_MODE: 'proxy' }), 'proxy');
  assert.equal(pickMode(u('?m=raro'), {}), 'redirect');
  assert.equal(pickMode(u(''), { DEFAULT_MODE: 'basura' }), 'redirect');
  assert.equal(pickMode(u('?m=relay'), {}), 'relay');
  assert.equal(pickMode(u(''), { DEFAULT_MODE: 'auto' }), 'auto');
});

/** handle() con Microsoft simulado: un archivo `nombre` cuya URL directa es https://my.microsoftpersonalcontent.com/d */
async function conMicrosoft(nombre, fn) {
  const real = globalThis.fetch;
  const pedidas = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    pedidas.push(url);
    if (url.includes('badgerp')) return Response.json({ token: 't', expiryTimeUtc: new Date(Date.now() + 7 * 864e5).toISOString() });
    if (url.endsWith('/permission')) return Response.json({ roles: ['read'] });
    if (url.includes('/shares/')) return Response.json({ name: nombre, size: 10, file: { mimeType: 'application/x-test' }, '@content.downloadUrl': 'https://my.microsoftpersonalcontent.com/d' });
    return new Response('0123456789', { status: init.headers?.range ? 206 : 200, headers: { 'content-type': 'application/x-test' } });
  };
  try {
    return await fn(pedidas);
  } finally {
    globalThis.fetch = real;
  }
}

test('relay: el Worker sirve él mismo; la instancia propia manda a su Worker, y sin Worker hace de proxy', async () => {
  await conMicrosoft('a.7z', async (pedidas) => {
    const w = await handle(new Request('https://w.example/raw/v/c/1a/rel1?m=relay', { headers: { range: 'bytes=0-9' } }), { REDIRECT_ONLY: true, PROXY_BASE: 'https://casa.example/' });
    assert.equal(w.status, 206);
    assert.equal(await w.text(), '0123456789');
    assert.equal(w.headers.get('access-control-allow-origin'), '*');
    assert.equal(pedidas.at(-1), 'https://my.microsoftpersonalcontent.com/d');

    const casa = await handle(new Request('https://casa.example/raw/v/c/1a/rel1?m=relay'), { RELAY_URL: 'https://w.example/relay' });
    assert.equal(casa.status, 302);
    assert.equal(casa.headers.get('location'), 'https://w.example/raw/v/c/1a/rel1?m=relay');

    let usado = 0;
    const sola = await handle(new Request('https://casa.example/raw/v/c/1a/rel1?m=relay'), { proxy: async () => (usado++, new Response('x')) });
    assert.equal(sola.status, 200);
    assert.equal(usado, 1, 'usa el proxy que le pasa Node');
  });
});

test('auto: el navegador recibe una página que mide las dos vías; bots, /raw y descargadores, lo de siempre', async () => {
  const env = { DEFAULT_MODE: 'auto', RELAY_URL: 'https://w.example/relay' };
  const nav = { 'sec-fetch-dest': 'document', 'user-agent': 'Mozilla/5.0 Chrome/130.0' };
  await conMicrosoft('a.7z', async () => {
    const pagina = await handle(new Request('https://casa.example/v/c/1a/auto1', { headers: nav }), env);
    const html = await pagina.text();
    assert.match(pagina.headers.get('content-type'), /html/);
    assert.match(html, /"\/raw\/v\/c\/1a\/auto1\?m=redirect","https:\/\/w\.example\/raw\/v\/c\/1a\/auto1\?m=relay"/);
    assert.doesNotThrow(() => new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]), 'el guion es JavaScript válido');

    const curl = await handle(new Request('https://casa.example/v/c/1a/auto1', { headers: { 'user-agent': 'curl/8' } }), env);
    assert.equal(curl.status, 302, 'sin navegador, el archivo');
    assert.equal(curl.headers.get('location'), 'https://my.microsoftpersonalcontent.com/d');
    const raw = await handle(new Request('https://casa.example/raw/v/c/1a/auto1', { headers: nav }), env);
    assert.equal(raw.status, 302);

    const bot = await (await handle(new Request('https://casa.example/v/c/1a/auto1', { headers: { 'user-agent': 'Discordbot/2.0' } }), env)).text();
    assert.doesNotMatch(bot, /<script>/);
    const sinRelevo = await handle(new Request('https://casa.example/v/c/1a/auto1', { headers: nav }), { DEFAULT_MODE: 'auto' });
    assert.equal(sinRelevo.status, 302, 'sin relevo no hay nada que medir');
  });
  await conMicrosoft('a.mp4', async () => {
    const html = await (await handle(new Request('https://w.example/v/c/1a/auto2?m=auto', { headers: nav }), { REDIRECT_ONLY: true })).text();
    assert.match(html, /<video controls/, 'el vídeo nace sin origen');
    assert.match(html, /"https:\/\/w\.example\/raw\/v\/c\/1a\/auto2\?m=relay"/, 'en el Worker, el relevo es él mismo');
    const fijo = await (await handle(new Request('https://w.example/v/c/1a/auto2?m=redirect', { headers: nav }), { REDIRECT_ONLY: true })).text();
    assert.match(fijo, /<video src="\/raw\/v\/c\/1a\/auto2\?m=redirect"/);
    assert.doesNotMatch(fijo, /<script>/);
  });
});

test('proxy: pasa lo de reproducir y saltar, quita attachment y lo demás', () => {
  const up = new Headers({
    'content-type': 'video/mp4',
    'content-length': '100',
    'content-range': 'bytes 0-99/1000',
    'accept-ranges': 'bytes',
    'content-disposition': 'attachment; filename="x.mp4"',
    'set-cookie': 'a=b',
  });
  const h = proxyHeaders(up, 'vídeo de prueba.mp4');
  assert.equal(h.get('content-type'), 'video/mp4');
  assert.equal(h.get('content-range'), 'bytes 0-99/1000');
  assert.equal(h.get('accept-ranges'), 'bytes');
  assert.equal(h.get('content-disposition'), "inline; filename*=UTF-8''v%C3%ADdeo%20de%20prueba.mp4");
  assert.equal(h.get('set-cookie'), null);
});

test('tipo: por mimeType y, si no sirve, por extensión', () => {
  assert.equal(kindOf('video/mp4', 'a.mp4'), 'video');
  assert.equal(kindOf('image/png', 'a'), 'image');
  assert.equal(kindOf('application/octet-stream', 'canción.FLAC'), 'audio');
  assert.equal(kindOf('application/octet-stream', 'clip.mkv'), 'video');
  assert.equal(kindOf('application/pdf', 'doc.pdf'), 'other');
  assert.equal(kindOf(undefined, 'sin-extension'), 'other');
});

test('tempauth: se lee exp; si no se puede, unos minutos', () => {
  const t = 'v1e.' + btoa(JSON.stringify({ exp: '1792298510' })).replace(/=+$/, '') + '.firma';
  assert.equal(tempauthExp('https://x.example/download.aspx?tempauth=' + t), 1792298510000);
  const fallback = tempauthExp('https://x.example/sin-token');
  assert.ok(fallback > Date.now() && fallback < Date.now() + 3600e3);
});

test('bots', () => {
  assert.ok(isBot('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'));
  assert.ok(isBot('TelegramBot (like TwitterBot)'));
  assert.ok(!isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0'));
  assert.ok(!isBot(undefined));
});

test('Workers: proxy se manda a PROXY_BASE o se queda en redirect, sin llamar a Microsoft', async () => {
  const req = new Request('https://segovia.workers.dev/raw/v/c/1a/abc?m=proxy');
  const r = await handle(req, { REDIRECT_ONLY: true, PROXY_BASE: 'https://casa.example/' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://casa.example/raw/v/c/1a/abc?m=proxy');
});

test('rutas que no son de Segovia y métodos raros', async () => {
  assert.equal((await handle(new Request('https://s.example/favicon.ico'))).status, 404);
  assert.equal((await handle(new Request('https://s.example/v/c/1a/abc', { method: 'POST' }))).status, 405);
});

test('enlace de «puede editar»: Segovia no lo sirve', async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/token')) return Response.json({ token: 't', expiryTimeUtc: new Date(Date.now() + 7 * 864e5).toISOString() });
    if (u.endsWith('/permission')) return Response.json({ roles: ['write'] });
    return Response.json({ name: 'a.7z', size: 1, file: { mimeType: 'application/x-7z-compressed' }, '@content.downloadUrl': 'https://x.example/d' });
  };
  const r = await handle(new Request('https://s.example/u/c/1a/editar'));
  assert.equal(r.status, 403);
  assert.match(await r.text(), /puede editar/);
});

test('relay: solo reenvía a sesiones de subida de OneDrive personal', async () => {
  assert.ok(relayTarget('https://my.microsoftpersonalcontent.com/personal/abc/_api/v2.0/drive/items/x/uploadSession?guid=1'));
  assert.ok(relayTarget('https://sn3302.up.1drv.com/up/abc'));
  for (const v of [null, '', 'no', 'http://my.microsoftpersonalcontent.com/x', 'https://evil.example/my.microsoftpersonalcontent.com', 'https://my.microsoftpersonalcontent.com.evil.example/'])
    assert.equal(relayTarget(v), null, v);
  const env = { PROXY_BASE: 'https://casa.example/' };
  const pre = await relay(new Request('https://w.example/relay', { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://casa.example');
  const mal = await relay(new Request('https://w.example/relay', { method: 'PUT', headers: { 'x-upload-url': 'https://evil.example/' }, body: 'x' }), env);
  assert.equal(mal.status, 400);
});

test('relay: al bajar pasa el rango a Microsoft y devuelve su respuesta; a otro destino, no', async () => {
  const fuera = await relay(new Request('https://w.example/relay', { headers: { 'x-download-url': 'https://evil.example/x', range: 'bytes=0-9' } }));
  assert.equal(fuera.status, 400);
  const real = globalThis.fetch;
  let visto;
  globalThis.fetch = async (url, init) => ((visto = { url, ...init.headers }), new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 5-14/100', 'set-cookie': 'no' } }));
  try {
    const r = await relay(new Request('https://w.example/relay', { headers: { 'x-download-url': 'https://my.microsoftpersonalcontent.com/d?tempauth=t', range: 'bytes=5-14', cookie: 'mia' } }));
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 5-14/100');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(await r.text(), '0123456789');
    assert.deepEqual(visto, { url: 'https://my.microsoftpersonalcontent.com/d?tempauth=t', range: 'bytes=5-14' });
  } finally {
    globalThis.fetch = real;
  }
});

test('subida: partes, nombres y por dónde sigue', () => {
  assert.deepEqual(partes(100), [[0, 100]]);
  const p = partes(2 ** 31 + 5);
  assert.equal(p.length, 6);
  assert.equal(p[0][0], 0);
  assert.equal(p.at(-1)[1], 2 ** 31 + 5);
  for (let i = 1; i < p.length; i++) assert.equal(p[i][0], p[i - 1][1]);
  assert.deepEqual(partes(10, 3, 5), [[0, 4], [4, 8], [8, 10]]);
  assert.equal(nombreParte('fotos.7z', 0), 'fotos.7z.001');
  assert.equal(nombreParte('fotos.7z', 11), 'fotos.7z.012');
  assert.equal(esperado({ nextExpectedRanges: ['26214400-'] }), 26214400);
});

test('carpetas: lo compartido se abre por su unidad real; un archivo no es carpeta', () => {
  const propia = { id: 'A!1', name: 'Mía', folder: {}, parentReference: { driveId: 'A' } };
  assert.deepEqual(carpeta(propia), { nombre: 'Mía', base: '/drives/A/items/A!1' });
  const acceso = { id: 'A!2', name: 'De otro', remoteItem: { id: 'B!9', folder: {}, parentReference: { driveId: 'B' } } };
  assert.deepEqual(carpeta(acceso), { nombre: 'De otro', base: '/drives/B/items/B!9', compartida: true });
  // En una búsqueda lo remoto trae `folder` y `remoteItem` a la vez: manda `remoteItem`.
  assert.equal(carpeta({ ...acceso, folder: {}, parentReference: { driveId: 'A' } }).base, '/drives/B/items/B!9');
  assert.equal(carpeta({ id: 'A!3', name: 'x.7z', file: {} }), null);
  assert.equal(carpeta({ id: 'A!4', name: 'x.7z', remoteItem: { id: 'B!4', file: {} } }), null);
  assert.equal(unidadDe('/drives/B/items/B!9'), 'B');
  assert.equal(unidadDe('/me/drive/root'), undefined);
});

test('búsqueda: solo carpetas, los accesos directos van a su destino y sin repetir', () => {
  const destino = { nombre: 'Familia', base: '/drives/B/items/B!9', compartida: true };
  const accesos = new Map([['A!2', destino]]);
  const r = deBusqueda(
    [
      { id: 'A!2', name: 'Familia', folder: {}, parentReference: { driveId: 'A' } }, // el acceso directo, como carpeta normal
      { id: 'A!7', name: 'Familia', folder: {}, remoteItem: { id: 'B!9', folder: {}, parentReference: { driveId: 'B' } } }, // la carpeta real
      { id: 'A!8', name: 'foto.png', file: {} },
      { id: 'A!1', name: 'Mía', folder: {}, parentReference: { driveId: 'A' } },
    ],
    accesos,
  );
  assert.deepEqual(r.map((c) => c.base), ['/drives/B/items/B!9', '/drives/A/items/A!1']);
  assert.deepEqual(sinRepetir([{ base: 'x', n: 1 }, { base: 'x', n: 2 }]), [{ base: 'x', n: 1 }]);
});
