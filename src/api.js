/**
 * Acceso autenticado a una carpeta de OneDrive, solo en Node (src/node.js).
 *
 *   /api/…                 con `Authorization: Bearer <clave>`, una clave por cliente
 *   /id/<id>/<firma>/<nombre>  el archivo, con una URL estable para un reproductor
 *
 * Todo cuelga de una carpeta raíz (`npm run segovia raiz`), y las rutas de la API
 * son relativas a ella. Las URL de /id/ salen firmadas en los listados: un
 * reproductor no puede llevar cabeceras, y así una URL filtrada abre ese archivo
 * y nada más, sin poner una clave general en cada tele.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lookup, Resolver } from 'node:dns';
import https from 'node:https';
import { Readable } from 'node:stream';
import { HttpError, proxyHeaders, tempauthExp } from './core.js';
import { graph, leer, guardar } from './graph.js';

const json = (status, datos) => new Response(JSON.stringify(datos), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** @returns {string[]} los trozos de una ruta relativa; `..` y compañía no salen de la raíz */
export function segmentos(ruta = '') {
  const s = String(ruta).split('/').filter(Boolean);
  if (s.some((x) => x === '.' || x === '..' || /[\\\0-\x1f]/.test(x))) throw new HttpError(400, 'Ruta no válida.');
  return s;
}

/** La ruta de Graph de un elemento dentro de la raíz. */
export function refRuta({ drive, item }, ruta) {
  const s = segmentos(ruta);
  return `/drives/${drive}/items/${item}` + (s.length ? `:/${s.map(encodeURIComponent).join('/')}:` : '');
}

export const firmar = (secreto, id) => createHmac('sha256', secreto).update(id).digest('base64url');

function iguales(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @returns {{ nombre: string, escribe?: boolean } | null} */
function cliente(req, config) {
  const clave = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!clave) return null;
  const hash = createHash('sha256').update(clave).digest('hex');
  for (const [nombre, c] of Object.entries(config.clientes ?? {})) if (iguales(hash, c.hash)) return { nombre, ...c };
  return null;
}

// Microsoft entrega los vídeos como application/octet-stream, y el mimeType de
// Graph depende de lo que haya analizado; la extensión es lo único siempre igual.
const TIPOS = { mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo' };
export const tipoDe = (nombre, mime) => TIPOS[nombre.split('.').pop().toLowerCase()] ?? mime ?? 'application/octet-stream';

// ── Servir por ID ────────────────────────────────────────────────────────────

const enlaces = new Map(); // id → { url, exp, nombre, mime }
const pidiendo = new Map(); // id → la petición en curso, para no repetirla si llegan varias a la vez

/** Los datos del archivo y su URL directa. `caducada` es la URL que acaba de fallar, si la hay. */
function enlace(id, drive, caducada) {
  const hit = enlaces.get(id);
  if (hit && hit.url !== caducada && hit.exp > Date.now()) return hit;
  if (pidiendo.has(id)) return pidiendo.get(id);
  const p = (async () => {
    const r = await graph(`/drives/${drive}/items/${encodeURIComponent(id)}`);
    if (r.status === 404) throw new HttpError(404, 'Ese archivo ya no existe.');
    if (!r.ok) throw new HttpError(502, `Microsoft responde ${r.status}.`);
    const d = await r.json();
    const url = d['@microsoft.graph.downloadUrl'];
    if (!url) throw new HttpError(415, 'Eso no es un archivo.');
    if (enlaces.size > 1000) enlaces.clear(); // ponytail: vaciado a lo bruto, como en core.js; un LRU si hay tráfico de verdad
    // Dura una hora; se deja de usar antes para no repartir enlaces a punto de morir.
    const e = { url, exp: tempauthExp(url) - 5 * 60e3, nombre: d.name, mime: tipoDe(d.name, d.file?.mimeType) };
    enlaces.set(id, e);
    return e;
  })().finally(() => pidiendo.delete(id));
  pidiendo.set(id, p);
  return p;
}

// ── Elegir servidor de Microsoft ─────────────────────────────────────────────
//
// El mismo archivo, a la misma hora y desde la misma casa va a 90 MB/s o a 0,5
// según el servidor de Microsoft que toque, y el DNS reparte con rachas de un
// minuto entero hacia los lentos: reintentar a ciegas no basta. Cada instancia
// aprende de sus propias conexiones cuál le va bien, porque depende de las rutas
// de cada casa. Sin IP fijas, que Microsoft las cambia; el certificado se sigue
// comprobando contra el nombre, así que elegir IP no abre ningún agujero.

const MEMORIA = 10 * 60e3;
let bueno = null; // { ip, hasta }
const malos = new Map(); // ip → hasta cuándo evitarla
const publico = new Resolver();
publico.setServers(['1.1.1.1', '8.8.8.8']);

const esMalo = (ip) => malos.get(ip) > Date.now();

// Cuando lo lento no es un servidor sino la ruta entera hasta Microsoft (medido: 0,9 MB/s directo y 55
// por Cloudflare, a la vez y contra el mismo servidor), se pide por el relevo de RELAY_URL, el mismo de
// las subidas. Se empieza siempre directo; una conexión directa lenta lo activa un rato, y si el relevo
// falla o también va lento se vuelve a lo directo.
const MEMORIA_RELEVO = 60 * 60e3;
let relevoHasta = 0;
let relevoMalo = 0;
export const porRelevo = () => Boolean(process.env.RELAY_URL) && relevoHasta > Date.now() && relevoMalo < Date.now();
function fallaRelevo(motivo) {
  console.log(`El relevo falla (${motivo}): diez minutos sin él`);
  relevoMalo = Date.now() + MEMORIA;
}

// Los que alguna vez han ido rápido se recuerdan en disco: Microsoft pasa días dando por
// DNS solo los lentos, y los rápidos siguen sirviendo. Los enseñó el DNS para este mismo
// nombre y el certificado se comprueba igual; uno que deje de responder se marca y se olvida.
const ARCHIVO_IPS = 'servidores.json';
const CADUCA = 30 * 24 * 3600e3;
let rapidos = null; // ip → última vez que fue rápida
function recordados() {
  if (!rapidos) {
    rapidos = new Map();
    try {
      for (const [ip, t] of Object.entries(leer(ARCHIVO_IPS) ?? {})) if (t > Date.now() - CADUCA) rapidos.set(ip, t);
    } catch {
      // un archivo roto no impide servir: se vuelve a aprender
    }
  }
  return rapidos;
}
function recordar(ip) {
  const m = recordados();
  const nueva = !(m.get(ip) > Date.now() - 3600e3); // a disco, como mucho una vez por hora y servidor
  m.set(ip, Date.now());
  if (!nueva) return;
  rapidos = new Map([...m].sort((a, b) => b[1] - a[1]).slice(0, 20));
  guardarRecordados();
}
function guardarRecordados() {
  try {
    guardar(ARCHIVO_IPS, Object.fromEntries(recordados()));
  } catch (e) {
    console.error('No se han podido guardar los servidores rápidos:', e.message);
  }
}

/** Lo que aprende cada conexión: `rapida` si ha dado de verdad lo pedido; `lenta` si se ha quedado corta. */
export function aprender(ip, { rapida, lenta, relevo }) {
  if (relevo) {
    if (lenta) relevoMalo = Date.now() + MEMORIA;
    else if (rapida) relevoHasta = Date.now() + MEMORIA_RELEVO; // mientras vaya bien, se sigue con él
    return;
  }
  if (lenta && process.env.RELAY_URL && relevoHasta < Date.now()) {
    console.log('Microsoft va lento en directo: una hora por el relevo');
    relevoHasta = Date.now() + MEMORIA_RELEVO;
  }
  if (!ip) return;
  if (rapida) {
    bueno = { ip, hasta: Date.now() + MEMORIA };
    malos.delete(ip);
    recordar(ip);
  }
  if (lenta) {
    malos.set(ip, Date.now() + MEMORIA);
    if (bueno?.ip === ip) bueno = null;
  }
}

/** @returns {string | null} la IP a usar de entre las que da el DNS, o null si hay que pedir otra opinión */
export function elegirIp(ips) {
  if (bueno?.hasta > Date.now()) return bueno.ip;
  // Antes que uno del que no se sabe nada, uno que ya ha ido rápido aunque el DNS no lo dé ahora.
  const conocidas = [...recordados().keys()].filter((ip) => !esMalo(ip));
  const sanas = conocidas.length ? conocidas : ips.filter((ip) => !esMalo(ip));
  return sanas.length ? sanas[Math.floor(Math.random() * sanas.length)] : null;
}

function buscar(host, op, cb) {
  const dar = (ip) => (op.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
  lookup(host, { family: 4, all: true }, (e, dirs) => {
    if (e) return lookup(host, op, cb); // sin IPv4 no hay nada que elegir: lo normal
    const ips = dirs.map((d) => d.address);
    const ip = elegirIp(ips);
    if (ip) return dar(ip);
    publico.resolve4(host, (_, otras = []) => dar(elegirIp(otras) ?? ips[0]));
  });
}

// Sin keep-alive: una conexión reutilizada se saltaría la elección de servidor.
const agente = new https.Agent({ keepAlive: false });
const PLAZO_RESPUESTA = 5000; // ms para conectar y recibir las cabeceras

// PROXY_SALIDA: dirección local desde la que salir hacia Microsoft, para llevar solo este tráfico por otra
// ruta (un túnel) cuando la del proveedor va mal. Si esa salida falla, se deja de usar un rato.
let salidaMala = 0;
const salida = () => (process.env.PROXY_SALIDA && salidaMala < Date.now() ? process.env.PROXY_SALIDA : undefined);

const intento = ({ url, method, headers, signal }, { relevo = method === 'GET' && porRelevo(), local = salida() } = {}) =>
  new Promise((ok, ko) => {
    let ip;
    const elegir = (host, op, cb) => buscar(host, op, (e, a, f) => ((ip = Array.isArray(a) ? a[0]?.address : a), cb(e, a, f)));
    // Por el relevo no hay servidor de Microsoft que elegir: lo elige Cloudflare.
    const req = (relevo
      ? https.request(process.env.RELAY_URL, { method, headers: { ...headers, 'x-download-url': url }, signal, agent: agente })
      : https.request(url, { method, headers, signal, agent: agente, lookup: elegir, localAddress: local })
    ).on('response', (res) => {
      res.socket.setTimeout(0); // a partir de aquí, de los parones se ocupa `vigilado`
      const vacia = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
      if (vacia) res.resume();
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
      ok(Object.assign(new Response(vacia ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }), relevo ? { relevo } : { ip: res.socket.remoteAddress }));
    });
    // En el socket y no en la petición, que no cuenta el tiempo de conectar: una IP que ya no existe ni rechaza ni contesta.
    req.on('socket', (s) => s.setTimeout(PLAZO_RESPUESTA, () => req.destroy(Object.assign(new Error('Microsoft no contesta'), { code: 'ETIMEDOUT' }))));
    req.on('error', (e) => ko(Object.assign(e, relevo ? { relevo } : { ip, local }))).end();
  });

/** Como fetch, pero eligiendo servidor y diciendo cuál ha sido en `ip`. Se sustituye en los tests. */
export const red = {
  // Un servidor recordado puede haber dejado de servir: si no contesta o falla, se descarta y se repite con otro.
  pedir: async (p) => {
    let r;
    try {
      r = await intento(p);
    } catch (e) {
      if (p.signal?.aborted) throw e;
      if (e.relevo) {
        fallaRelevo(e.code ?? e.message);
        return intento(p, { relevo: false });
      }
      if (e.local) {
        // No se sabe si ha fallado el servidor o la salida: se repite por la conexión normal y sin culpar al servidor.
        console.log(`La salida ${e.local} falla (${e.code ?? e.message}): diez minutos por la conexión normal`);
        salidaMala = Date.now() + MEMORIA;
        return intento(p);
      }
      if (!e.ip) throw e;
      console.log(`Servidor descartado, ${e.ip}: ${e.code ?? e.message}`);
      aprender(e.ip, { lenta: true });
      if (recordados().delete(e.ip)) guardarRecordados();
      return intento(p);
    }
    // Un 401 o un 403 por el relevo son de Microsoft (la URL caducó) y los resuelve quien llama; un 416, un rango imposible.
    if (r.relevo && !r.ok && ![401, 403, 416].includes(r.status)) {
      fallaRelevo(`responde ${r.status}`);
      await r.body?.cancel();
      return intento(p, { relevo: false });
    }
    if (r.status < 500 && r.status !== 421) return r;
    console.log(`Servidor descartado, ${r.ip}: responde ${r.status}`);
    aprender(r.ip, { lenta: true });
    await r.body?.cancel();
    return intento(p);
  },
};

/**
 * El cuerpo de la respuesta, que cambia de conexión si hace falta sin que el
 * reproductor se entere: si mientras espera llega poco, o la conexión se corta, se
 * abre otra desde el mismo byte. Lo lento se juzga solo por el tiempo esperando a
 * Microsoft: un reproductor que lee despacio porque no necesita más no dispara nada.
 *
 * @param {Response & { ip?: string }} primera
 * @param {(rango: string) => Promise<Response & { ip?: string }>} abrir pide `rango` a Microsoft
 */
export function vigilado(primera, abrir, desde, hasta, { minBps = 10e6, ventana = 2000, plazo = 15000, signal } = {}) {
  let lector = primera.body.getReader();
  let ip = primera.ip;
  let relevo = primera.relevo;
  let pos = desde;
  let espera = 0;
  let bytes = 0;
  let inicioVentana = Date.now();
  let juicio = ventana;
  let seguidos = 0;
  let anterior = 0; // bytes/s de esta conexión en la ventana anterior

  const cambiar = async (motivo) => {
    if (++seguidos > 3) throw new Error(`Microsoft no da datos: ${motivo}`);
    console.log(`Cambio de conexión en el byte ${pos}, desde ${relevo ? 'el relevo' : (ip ?? '?')}: ${motivo}`);
    lector.cancel().catch(() => {});
    const rango = `bytes=${pos}-${hasta}`;
    const r = await abrir(rango);
    if (r.status !== 206 || !r.headers.get('content-range')?.startsWith(`bytes ${pos}-`)) {
      await r.body?.cancel();
      throw new Error(`Microsoft responde ${r.status} a ${rango}`);
    }
    lector = r.body.getReader();
    ip = r.ip;
    relevo = r.relevo;
    espera = bytes = anterior = 0;
    inicioVentana = Date.now();
  };

  return new ReadableStream(
    {
      async pull(ctl) {
        for (;;) {
          const inicio = Date.now();
          let tope;
          let r;
          try {
            r = await Promise.race([lector.read(), new Promise((ok) => (tope = setTimeout(ok, plazo, null)))]);
          } catch (e) {
            if (signal?.aborted) throw e; // se ha ido el reproductor: no hay nada que retomar
            await cambiar(`corte (${e.cause?.code ?? e.code ?? e.message})`);
            continue;
          } finally {
            clearTimeout(tope);
          }
          espera += Date.now() - inicio;
          if (r === null) {
            aprender(ip, { lenta: true, relevo });
            await cambiar(`${plazo / 1000} s sin datos`);
            continue;
          }
          if (r.done) {
            if (pos > hasta) return ctl.close();
            await cambiar('la conexión acabó antes de tiempo');
            continue;
          }
          ctl.enqueue(r.value);
          pos += r.value.length;
          bytes += r.value.length;
          seguidos = 0;
          if (minBps && espera >= juicio) {
            // Microsoft no arranca a tope: cada conexión acelera durante muchos segundos. Cambiar una que va
            // a más es volver a empezar desde lo más lento, así que solo se cambia la que va mal y no mejora.
            const bps = (bytes * 1000) / espera;
            const lenta = bps < minBps && bps <= anterior * 1.1;
            anterior = bps;
            const mbs = (bps / 1e6).toFixed(1);
            // «Rápida» cuenta el tiempo real: si no, una lenta que apenas se espera lo parecería.
            aprender(ip, { lenta, rapida: (bytes * 1000) / (Date.now() - inicioVentana) >= minBps, relevo });
            espera = bytes = 0;
            inicioVentana = Date.now();
            // Si todo va lento (hora punta, una línea modesta), no se insiste: cada vez se espera el doble.
            juicio = lenta ? Math.min(juicio * 2, 60000) : ventana;
            if (lenta && pos <= hasta) await cambiar(`${mbs} MB/s`);
          }
          return;
        }
      },
      cancel: (e) => lector.cancel(e),
    },
    { highWaterMark: 0 },
  );
}

async function servir(req, id, drive, url) {
  let e = await enlace(id, drive);
  if (url.searchParams.get('m') === 'redirect') return new Response(null, { status: 302, headers: { location: e.url } });

  const pedir = async (headers) => {
    const una = () => red.pedir({ url: e.url, method: req.method, headers, signal: req.signal });
    let r = await una();
    if (r.status === 401 || r.status === 403) {
      // Caducó: se pide otra y se repite el mismo rango, sin que el reproductor se entere.
      await r.body?.cancel();
      e = await enlace(id, drive, e.url);
      r = await una();
    }
    return r;
  };

  const headers = {};
  for (const k of ['range', 'if-range']) if (req.headers.has(k)) headers[k] = req.headers.get(k);
  const up = await pedir(headers);
  const h = proxyHeaders(up.headers, e.nombre);
  h.set('content-type', e.mime);
  h.set('accept-ranges', 'bytes');

  // Lo que queda por entregar; sin saberlo, no se puede retomar.
  const rango = up.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\//);
  const hasta = rango ? Number(rango[2]) : Number(up.headers.get('content-length')) - 1;
  if (req.method !== 'GET' || !up.ok || !up.body || !(hasta >= 0)) return new Response(up.body, { status: up.status, headers: h });
  const minBps = process.env.PROXY_MIN_MBS === undefined ? undefined : Number(process.env.PROXY_MIN_MBS) * 1e6;
  const cuerpo = vigilado(up, (r) => pedir({ range: r }), rango ? Number(rango[1]) : 0, hasta, { minBps, signal: req.signal });
  return new Response(cuerpo, { status: up.status, headers: h });
}

// ── API ──────────────────────────────────────────────────────────────────────

const CAMPOS = 'id,name,size,file,folder,video,description,lastModifiedDateTime';

/** Convierte un error de Graph en uno para el cliente; el token y demás no salen de aquí. */
async function fallo(r) {
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) return new HttpError(404, 'No existe.');
  return new HttpError(r.status === 409 ? 409 : 502, d.error?.code ?? `Microsoft responde ${r.status}.`);
}

async function hijos(raiz, ruta) {
  const todos = [];
  let url = `${refRuta(raiz, ruta)}/children?$top=1000&$select=${CAMPOS}`;
  while (url) {
    const r = await graph(url);
    if (!r.ok) throw await fallo(r);
    const d = await r.json();
    todos.push(...d.value);
    url = d['@odata.nextLink'];
  }
  return todos;
}

const unir = (ruta, nombre) => (ruta ? `${ruta}/${nombre}` : nombre);

function archivo(x, ruta, config, base) {
  return {
    id: x.id,
    nombre: x.name,
    ruta,
    tamano: x.size,
    mime: tipoDe(x.name, x.file?.mimeType),
    video: x.video ?? null,
    descripcion: x.description ?? null,
    modificado: x.lastModifiedDateTime,
    url: `${base}/id/${encodeURIComponent(x.id)}/${firmar(config.firma, x.id)}/${encodeURIComponent(x.name)}`,
  };
}

async function listar(config, ruta, profundo, base) {
  const inicio = segmentos(ruta).join('/');
  const cola = [inicio];
  const carpetas = [];
  const archivos = [];
  const trabajador = async () => {
    // Si la cola está vacía un momento, este se va aunque otro vaya a añadir más: se pierde paralelismo, no carpetas.
    while (cola.length) {
      const actual = cola.pop();
      for (const x of await hijos(config.raiz, actual)) {
        const r = unir(actual, x.name);
        if (x.folder) {
          carpetas.push({ id: x.id, nombre: x.name, ruta: r });
          if (profundo) cola.push(r);
        } else archivos.push(archivo(x, r, config, base));
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabajador));
  return { carpetas, archivos };
}

async function cuerpo(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'El cuerpo tiene que ser JSON.');
  }
}

async function subida(config, { ruta, tamano, reemplazar }) {
  if (!segmentos(ruta).length || !(tamano > 0)) throw new HttpError(400, 'Hacen falta `ruta` y `tamano`.');
  // Cada cuenta tiene su cuota: mejor saberlo ahora que al cabo de 30 GB.
  const q = await graph(`/drives/${config.raiz.drive}?$select=quota`);
  if (q.ok) {
    const libre = (await q.json()).quota?.remaining;
    if (libre < tamano) throw new HttpError(507, `No cabe: quedan ${(libre / 1e9).toFixed(1)} GB en esa cuenta.`);
  }
  const r = await graph(`${refRuta(config.raiz, ruta)}/createUploadSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': reemplazar ? 'replace' : 'fail' } }),
  });
  if (!r.ok) throw await fallo(r);
  const d = await r.json();
  return { uploadUrl: d.uploadUrl, caduca: d.expirationDateTime };
}

async function rutaApi(req, url, config, quien) {
  const { pathname: p } = url;
  const ruta = url.searchParams.get('ruta') ?? '';
  const escribe = () => {
    if (!quien.escribe) throw new HttpError(403, 'Esta clave solo puede leer.');
  };

  if (p === '/api/lista' && req.method === 'GET') {
    const base = (process.env.PUBLIC_BASE_URL ?? url.origin).replace(/\/$/, '');
    return json(200, await listar(config, ruta, url.searchParams.has('profundo'), base));
  }
  if (p === '/api/archivo' && req.method === 'GET') {
    const r = await graph(`${refRuta(config.raiz, ruta)}?$select=${CAMPOS}`);
    if (r.status === 404) return json(200, { existe: false });
    if (!r.ok) throw await fallo(r);
    const d = await r.json();
    return json(200, { existe: true, id: d.id, tamano: d.size, carpeta: !!d.folder, descripcion: d.description ?? null });
  }
  if (p === '/api/archivo' && req.method === 'PATCH') {
    escribe();
    const c = await cuerpo(req);
    const r = await graph(refRuta(config.raiz, c.ruta), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: String(c.descripcion ?? '') }),
    });
    if (!r.ok) throw await fallo(r);
    return json(200, { descripcion: (await r.json()).description ?? null });
  }
  if (p === '/api/subida' && req.method === 'POST') {
    escribe();
    return json(200, await subida(config, await cuerpo(req)));
  }
  if (p === '/api/pruebas/caducar' && req.method === 'POST') {
    // Estropea la URL guardada, sin tocar su fecha: Microsoft contesta 401 como a
    // una caducada de verdad, y el siguiente trozo pasa por la renovación real.
    const { id } = await cuerpo(req);
    let caducados = 0;
    for (const [k, e] of enlaces)
      if (!id || k === id) {
        e.url = e.url.replace(/tempauth=[^&]+/, 'tempauth=v1e.caducado.caducado');
        caducados++;
      }
    return json(200, { caducados });
  }
  return json(404, { error: 'Esa ruta no existe.' });
}

/** @param {Request} req */
export async function api(req) {
  const url = new URL(req.url);
  const config = leer('config.json');
  // Sin configurar, la instancia es la pública de siempre: aquí no hay nada.
  if (!config?.raiz || !config.firma) return json(404, { error: 'Esta instancia no tiene acceso autenticado.' });

  try {
    if (url.pathname.startsWith('/id/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Solo GET y HEAD.\n', { status: 405 });
      const [, , idc, firma] = url.pathname.split('/');
      let id;
      try {
        id = decodeURIComponent(idc);
      } catch {
        return new Response('Enlace no válido.\n', { status: 403 });
      }
      if (!firma || !iguales(firma, firmar(config.firma, id))) return new Response('Enlace no válido.\n', { status: 403 });
      return await servir(req, id, config.raiz.drive, url);
    }
    const quien = cliente(req, config);
    if (!quien) return json(401, { error: 'Falta una clave válida.' });
    return await rutaApi(req, url, config, quien);
  } catch (e) {
    if (req.signal?.aborted) return new Response(null, { status: 499 });
    if (!e.status) console.error(e);
    return json(e.status ?? 502, { error: e.status ? e.message : 'No se pudo contactar con Microsoft.' });
  }
}
