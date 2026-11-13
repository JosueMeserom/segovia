/**
 * Núcleo de Segovia: un manejador Request → Response con APIs web, el mismo en
 * Cloudflare Workers (src/worker.js) y en Node (src/node.js).
 *
 * Cada petición resuelve el enlace compartido contra Microsoft con el token
 * anónimo "Badger", el mismo que usa la web de OneDrive al abrir un enlace sin
 * sesión. No hay nada guardado: la URL directa caduca en una hora y solo se
 * cachea en memoria hasta poco antes.
 */
import { fromPath, b64url } from '../landing/enlace.js';

const BADGER_APP = '5cbed6ac-a083-4e14-b191-b4ba07653de2';
const SHARES = 'https://my.microsoftpersonalcontent.com/_api/v2.0/shares/';

const BOTS =
  /discordbot|twitterbot|facebookexternalhit|telegrambot|slackbot|whatsapp|linkedinbot|mastodon|bluesky|skypeuripreview|redditbot|embedly|vkshare|pinterest/i;
export const isBot = (ua) => BOTS.test(ua ?? '');

const EXT = {
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'bmp'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'],
};

/** @returns {'video' | 'image' | 'audio' | 'other'} */
export function kindOf(mime = '', name = '') {
  const top = mime.split('/')[0];
  if (top in EXT) return top;
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return Object.keys(EXT).find((k) => EXT[k].includes(ext)) ?? 'other';
}

const MODOS = ['redirect', 'proxy', 'relay', 'auto'];

/** `?m=` del enlace; si no, DEFAULT_MODE de la instancia; si no, redirect. */
export function pickMode(url, env = {}) {
  for (const m of [url.searchParams.get('m'), env.DEFAULT_MODE]) if (MODOS.includes(m)) return m;
  return 'redirect';
}

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** Cabeceras que se devuelven en modo proxy: las útiles para reproducir y saltar, e inline en vez de attachment. */
export function proxyHeaders(upstream, name) {
  const h = new Headers();
  for (const k of PASS) if (upstream.has(k)) h.set(k, upstream.get(k));
  h.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  return h;
}

/** Milisegundos en que caduca la URL directa. El tempauth lleva un JSON legible con `exp`. */
export function tempauthExp(downloadUrl) {
  try {
    const t = new URL(downloadUrl).searchParams.get('tempauth');
    const json = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    return Number(JSON.parse(json).exp) * 1000;
  } catch {
    return Date.now() + 10 * 60e3;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Resolución ───────────────────────────────────────────────────────────────

let badger = null; // { token, exp }

async function badgerToken(force) {
  // El token dura 7 días; se renueva con una hora de margen.
  if (force || !badger || badger.exp - 3600e3 < Date.now()) {
    const r = await fetch('https://api-badgerp.svc.ms/v1.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: BADGER_APP }),
    });
    if (!r.ok) throw new HttpError(502, `Microsoft no da token anónimo (${r.status}).`);
    const d = await r.json();
    badger = { token: d.token, exp: Date.parse(d.expiryTimeUtc) };
  }
  return badger.token;
}

const items = new Map(); // enlace → { item, exp }

async function share(link, path) {
  const url = `${SHARES}u!${b64url(link)}/${path}`;
  let r;
  for (let i = 0; i < 2; i++) {
    // `Prefer: autoredeem` es obligatorio la primera vez que un token abre un
    // enlace; sin él, 403. Se manda siempre: no molesta en las siguientes.
    r = await fetch(url, { headers: { authorization: 'Badger ' + (await badgerToken(i > 0)), prefer: 'autoredeem' } });
    if (r.status !== 401) break;
  }
  if (r.status === 403 || r.status === 404) throw new HttpError(404, 'El enlace no existe o ya no está compartido.');
  if (!r.ok) throw new HttpError(502, `Microsoft responde ${r.status}.`);
  return r.json();
}

/** Datos del archivo y su URL directa, de la caché si aún no está cerca de caducar. */
export async function resolve(link, fresh = false) {
  const hit = items.get(link);
  if (!fresh && hit && hit.exp > Date.now()) return hit.item;

  const [d, perm] = await Promise.all([share(link, 'driveitem?$expand=thumbnails'), share(link, 'permission')]);
  // La ruta de Segovia ES el enlace: uno de «puede editar» daría permiso de
  // escritura a cualquiera que viera el enlace de Segovia.
  if (perm.roles?.includes('write'))
    throw new HttpError(403, 'Es un enlace de «puede editar»: con él cualquiera podría cambiar el archivo. Comparte uno de «puede ver».');
  if (d.folder) throw new HttpError(415, 'Es una carpeta: Segovia solo sirve archivos.');

  const item = {
    name: d.name,
    size: d.size,
    mime: d.file?.mimeType ?? 'application/octet-stream',
    media: d.video ?? d.image ?? {},
    url: d['@content.downloadUrl'],
    thumb: d.thumbnails?.[0]?.large?.url,
  };
  // Microsoft acepta la URL hasta ~5 min después de `exp`; aquí se deja de
  // usar 5 min antes, para no repartir enlaces a punto de morir.
  if (items.size > 1000) items.clear(); // ponytail: vaciado a lo bruto; un LRU si algún día hay tráfico de verdad
  items.set(link, { item, exp: tempauthExp(item.url) - 5 * 60e3 });
  return item;
}

// ── Respuestas ───────────────────────────────────────────────────────────────

const text = (status, body) => new Response(body + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function proxy(req, link, item) {
  const headers = {};
  for (const k of ['range', 'if-range']) if (req.headers.has(k)) headers[k] = req.headers.get(k);
  const pedir = (url) => fetch(url, { method: req.method, headers, signal: req.signal });

  let up = await pedir(item.url);
  if (up.status === 401 || up.status === 403) {
    // Caducó entre la caché y la petición: se resuelve de nuevo una vez.
    await up.body?.cancel();
    up = await pedir((await resolve(link, true)).url);
  }
  const h = proxyHeaders(up.headers, item.name);
  h.set('access-control-allow-origin', '*'); // la página en modo auto mide esta vía desde otro origen
  return new Response(up.body, { status: up.status, headers: h });
}

// Modo auto: el navegador de quien mira prueba a la vez la descarga directa de Microsoft y la del
// relevo, un par de segundos, y se queda con la mejor. Solo él sabe cómo le va Microsoft a su conexión.
// Lo directo gana salvo que el relevo vaya claramente mejor: no gasta nada de nadie.
const MEDIR = `
const medir = async (u) => {
  const ac = new AbortController();
  const tope = setTimeout(() => ac.abort(), 4000);
  let n = 0, t0 = 0;
  try {
    const r = await fetch(u, { signal: ac.signal, cache: 'no-store' }); // de la caché no se aprende nada
    if (!r.ok) return 0;
    t0 = performance.now();
    const l = r.body.getReader();
    for (;;) {
      const { done, value } = await l.read();
      if (done) break;
      n += value.length;
      if (performance.now() - t0 > 1500 || n > 20e6) break;
    }
  } catch {} finally { clearTimeout(tope); ac.abort(); }
  return t0 ? n / Math.max(performance.now() - t0, 50) : 0;
};
const elegir = async ([directo, relevo]) => {
  const [d, r] = await Promise.all([medir(directo), medir(relevo)]);
  return r > d * 1.5 ? relevo : directo;
};`;

/** @param {string | null} relevo origen del relevo si la página tiene que medir y elegir (modo auto) */
function page(item, kind, url, relevo = null) {
  const self = url.origin + url.pathname + url.search;
  // Los bots se bajan el archivo desde sus servidores: en redirect lo cogen
  // directamente de Microsoft. Por el proxy pasaría por la subida de casa, y
  // Discord abandona a los ~10 s; con el índice del MP4 al final necesita el
  // archivo entero. El `attachment` del redirect no le importa.
  const q = new URLSearchParams(url.search);
  q.set('m', 'redirect');
  const raw = `${url.origin}/raw${url.pathname}?${q}`;
  const thumb = url.origin + '/thumb' + url.pathname + url.search;
  const { width, height } = item.media;

  const meta = [
    ['og:site_name', 'Segovia'],
    ['og:title', item.name],
    ['og:url', self],
  ];
  if (kind === 'video') {
    meta.push(
      ['og:type', 'video.other'],
      ['og:video', raw],
      ['og:video:secure_url', raw],
      ['og:video:type', item.mime],
      ['og:video:width', width],
      ['og:video:height', height],
      ['og:image', thumb],
      ['twitter:card', 'player'],
      ['twitter:player:stream', raw],
      ['twitter:player:stream:content_type', item.mime],
      ['twitter:player:width', width],
      ['twitter:player:height', height],
    );
  } else if (kind === 'image') {
    meta.push(['og:image', raw], ['og:image:width', width], ['og:image:height', height], ['twitter:card', 'summary_large_image']);
  } else if (kind === 'audio') {
    meta.push(['og:audio', raw], ['og:audio:type', item.mime]);
    if (item.thumb) meta.push(['og:image', thumb]);
  } else {
    meta.push(['og:description', `${(item.size / 1e6).toFixed(1)} MB`]);
  }

  // En auto, el elemento nace sin origen y se lo pone el guion cuando ha elegido; sin JavaScript, lo directo.
  const src = relevo ? '' : ` src="${esc('/raw' + url.pathname + url.search)}"`;
  const vias = ['/raw' + url.pathname + '?m=redirect', relevo + '/raw' + url.pathname + '?m=relay'];
  const guion = !relevo
    ? ''
    : `<script>${MEDIR}
elegir(${JSON.stringify(vias).replace(/</g, '\\u003c')}).then((u) => {
  const e = document.querySelector('video, audio, img');
  if (e) return (e.src = u);
  document.querySelector('a').href = u;
  document.querySelector('p').textContent = 'Descargando. Si no empieza:';
  location.href = u;
});
</script>
<noscript><a href="${esc(vias[0])}">${esc(item.name)}</a></noscript>`;
  const body =
    {
      video: `<video${src} controls autoplay playsinline></video>`,
      audio: `<audio${src} controls autoplay></audio>`,
      image: `<img${src} alt="${esc(item.name)}">`,
      other: relevo
        ? `<div><p>Midiendo la conexión…</p><a href="${esc(vias[0])}">Descargar ${esc(item.name)}</a></div>`
        : `<a${src.replace('src', 'href')}>Descargar ${esc(item.name)}</a>`,
    }[kind] + guion;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(item.name)}</title>
${meta
  .filter(([, v]) => v != null)
  .map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`)
  .join('\n')}
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 16px system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  video, img { max-width: 100vw; max-height: 100vh; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * @param {Request} req
 * @param {{ DEFAULT_MODE?: string, REDIRECT_ONLY?: boolean, PROXY_BASE?: string, RELAY_URL?: string, proxy?: typeof proxy }} env
 *   `proxy`: cómo servir en modo proxy; Node pasa el suyo, que vigila la conexión con Microsoft (src/api.js).
 */
export async function handle(req, env = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Solo GET y HEAD.');
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/(raw|thumb)(\/.*)$/);
  const route = m?.[1] ?? 'page';
  const link = fromPath(m ? m[2] : url.pathname);
  if (!link) return text(404, 'Esto no es un enlace de Segovia.');

  let mode = pickMode(url, env);
  // El relevo es el Worker: él mismo si esto corre allí, o el de RELAY_URL si es la instancia propia.
  const relevo = env.REDIRECT_ONLY ? url.origin : env.RELAY_URL ? new URL(env.RELAY_URL).origin : null;
  // Auto solo cambia la página que ve un navegador; para todo lo demás (bots, /raw, descargadores) es redirect.
  const auto = mode === 'auto' && relevo;
  if (mode === 'auto') mode = 'redirect';
  if (mode === 'relay' && !env.REDIRECT_ONLY) {
    if (relevo) return redirect(relevo + url.pathname + url.search);
    mode = 'proxy'; // sin Worker, lo más parecido: pasar por aquí
  }
  if (mode === 'proxy' && env.REDIRECT_ONLY) {
    // Workers no hace proxy: se pasa a la instancia propia si la hay.
    if (env.PROXY_BASE) return redirect(env.PROXY_BASE.replace(/\/$/, '') + url.pathname + url.search);
    mode = 'redirect';
  }

  try {
    const item = await resolve(link);
    if (route === 'thumb') return item.thumb ? redirect(item.thumb) : text(404, 'Sin miniatura.');
    const kind = kindOf(item.mime, item.name);
    // Los bots reciben siempre las meta etiquetas. Las personas, el reproductor
    // si es multimedia (también para imágenes: un <img> ignora el attachment), y
    // el archivo tal cual si no.
    // En auto, también quien abre en su navegador un archivo que no es multimedia recibe página: hay que medir.
    const bot = isBot(req.headers.get('user-agent'));
    const navega = auto && !bot && req.headers.get('sec-fetch-dest') === 'document';
    if (route === 'page' && (kind !== 'other' || bot || navega)) {
      return new Response(page(item, kind, url, auto && !bot ? relevo : null), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return mode === 'redirect' ? redirect(item.url) : await (env.proxy ?? proxy)(req, link, item);
  } catch (e) {
    if (!e.status) console.error(e);
    return text(e.status ?? 502, e.status ? e.message : 'No se pudo contactar con Microsoft.');
  }
}
