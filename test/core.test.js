import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPath, fromPath, esEmpresa } from '../landing/enlace.js';
import { pickMode, kindOf, proxyHeaders, tempauthExp, isBot, handle } from '../src/core.js';
import { relay, relayTarget } from '../src/relay.js';
import { partes, nombreParte, esperado } from '../landing/subir.js';

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
