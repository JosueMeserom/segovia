/**
 * Subida a OneDrive desde la landing. Todo ocurre en el navegador: la sesión
 * con Microsoft (OAuth con PKCE, sin secreto), la lista de carpetas y los
 * bytes, que van del navegador a Microsoft o, si así va más rápido, por el
 * relevo de Cloudflare (src/relay.js). El servidor de Segovia no ve nada.
 *
 * Microsoft solo admite los trozos de un archivo en orden, así que lo que va en
 * paralelo son archivos. Para uno grande, se trocea en partes (.001, .002…) que
 * 7-Zip vuelve a juntar.
 */
import { toPath } from './enlace.js';

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite.All offline_access';
const PARALELO = 6;
const UMBRAL = 2 ** 30; // a partir de 1 GiB se trocea, si está marcado
// Trozos múltiplos de 320 KiB, como pide Microsoft. Por el relevo, más grandes:
// cada trozo es una ida y vuelta, y Workers acepta hasta 100 MB por petición.
const TROZO = { directo: 32 * 327680, relay: 160 * 327680 };
const K_SESION = 'segovia:sesion';
const K_DESTINO = 'segovia:destino';
const K_SUBIDA = 'segovia:subida:';

// ── Funciones puras (con test) ───────────────────────────────────────────────

/** Rangos [inicio, fin) de `n` partes casi iguales; una sola si no llega al umbral. */
export function partes(size, n = PARALELO, umbral = UMBRAL) {
  if (size < umbral) return [[0, size]];
  const p = Math.ceil(size / n);
  return Array.from({ length: Math.ceil(size / p) }, (_, i) => [i * p, Math.min((i + 1) * p, size)]);
}

/** nombre.7z, 2 → nombre.7z.003 */
export const nombreParte = (nombre, i) => `${nombre}.${String(i + 1).padStart(3, '0')}`;

/** Primer byte que Microsoft espera, de `nextExpectedRanges: ["26214400-"]`. */
export const esperado = (d) => Number(d?.nextExpectedRanges?.[0]?.split('-')[0]);

// ── Utilidades ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...hijos) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...hijos.filter((h) => h != null));
  return e;
}
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fmt = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
function tam(n) {
  for (const [u, d] of [['TB', 1e12], ['GB', 1e9], ['MB', 1e6], ['kB', 1e3]]) if (n >= d) return fmt.format(n / d) + ' ' + u;
  return n + ' B';
}
function tiempo(s) {
  if (!isFinite(s)) return '';
  if (s < 60) return Math.ceil(s) + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min';
}
const leer = (store, k) => {
  try {
    return JSON.parse(store.getItem(k));
  } catch {
    return null;
  }
};

// ── Sesión de Microsoft ──────────────────────────────────────────────────────

let config;
let refrescando = null;

async function canjear(params) {
  const r = await fetch(AUTH + 'token', { method: 'POST', body: new URLSearchParams({ client_id: config.clientId, scope: SCOPE, ...params }) });
  const d = await r.json();
  if (!r.ok) {
    sessionStorage.removeItem(K_SESION);
    pintarSesion();
    throw new Error(d.error_description?.split('\r\n')[0] ?? 'Microsoft no ha dado acceso.');
  }
  const s = { access: d.access_token, refresh: d.refresh_token, exp: Date.now() + d.expires_in * 1000 };
  sessionStorage.setItem(K_SESION, JSON.stringify(s));
  return s;
}

async function token() {
  const s = leer(sessionStorage, K_SESION);
  if (!s) throw new Error('La sesión se ha cerrado: vuelve a iniciarla.');
  if (s.exp - 5 * 60e3 > Date.now()) return s.access;
  refrescando ??= canjear({ grant_type: 'refresh_token', refresh_token: s.refresh }).finally(() => (refrescando = null));
  return (await refrescando).access;
}

async function entrar() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = location.origin + '/';
  const q = new URLSearchParams({
    client_id: config.clientId, response_type: 'code', redirect_uri: redirect, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
  });
  const w = open(AUTH + 'authorize?' + q, 'segovia-login', 'width=520,height=720');
  if (!w) throw new Error('El navegador ha bloqueado la ventana de Microsoft: permite las ventanas emergentes.');
  // Microsoft devuelve la ventana a esta misma landing con ?code=…; como es el
  // mismo origen, se lee desde aquí y se cierra.
  const vuelta = await new Promise((ok, ko) => {
    const t = setInterval(() => {
      if (w.closed) return clearInterval(t), ko(new Error('Se ha cerrado la ventana sin iniciar sesión.'));
      try {
        if (w.location.origin === location.origin && /[?&](code|error)=/.test(w.location.search)) {
          clearInterval(t);
          ok(new URLSearchParams(w.location.search));
          w.close();
        }
      } catch {}
    }, 250);
  });
  if (vuelta.get('state') !== state) throw new Error('La respuesta de Microsoft no cuadra; prueba otra vez.');
  if (!vuelta.get('code')) throw new Error(vuelta.get('error') === 'access_denied' ? 'Has denegado el permiso.' : vuelta.get('error_description') ?? vuelta.get('error'));
  await canjear({ grant_type: 'authorization_code', code: vuelta.get('code'), redirect_uri: redirect, code_verifier: verifier });
}

async function g(path, opt = {}) {
  const r = await fetch(path.startsWith('https:') ? path : GRAPH + path, {
    ...opt,
    headers: { authorization: 'Bearer ' + (await token()), 'content-type': 'application/json' },
  });
  const d = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error?.message || `Microsoft responde ${r.status}.`);
  return d;
}
const post = (path, body) => g(path, { method: 'POST', body: JSON.stringify(body) });

// ── Carpetas ─────────────────────────────────────────────────────────────────

const RAIZ = { nombre: 'Mi OneDrive', base: '/me/drive/root' };
const COMPARTIDO = { nombre: 'Compartido conmigo', base: 'compartido' };
let migas = [RAIZ];
const destino = () => migas.at(-1);

const carpeta = (x) =>
  x.folder
    ? { nombre: x.name, base: `/drives/${x.parentReference.driveId}/items/${x.id}` }
    : x.remoteItem?.folder && { nombre: x.name, base: `/drives/${x.remoteItem.parentReference.driveId}/items/${x.remoteItem.id}`, compartida: true };

async function listar() {
  const lista = $('carpetas');
  lista.replaceChildren(el('li', { className: 'vacio', textContent: 'Cargando…' }));
  pintarMigas();
  try {
    let url = destino() === COMPARTIDO ? '/me/drive/sharedWithMe' : `${destino().base}/children?$select=id,name,folder,remoteItem,parentReference&$top=500`;
    let todo = [];
    while (url) {
      const d = await g(url);
      todo.push(...d.value);
      url = d['@odata.nextLink'];
    }
    if (destino() === COMPARTIDO) todo = todo.map((x) => ({ ...x, folder: undefined }));
    const dirs = todo.map(carpeta).filter(Boolean).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (destino() === RAIZ) dirs.unshift({ ...COMPARTIDO, compartida: true, especial: true });
    lista.replaceChildren(
      ...dirs.map((c) =>
        el('li', {}, el('button', { type: 'button', className: c.compartida ? 'compartida' : '', onclick: () => abrir([...migas, c.especial ? COMPARTIDO : c]) }, icono(c.compartida ? 'gente' : 'carpeta'), el('span', { textContent: c.nombre }))),
      ),
    );
    if (!dirs.length) lista.replaceChildren(el('li', { className: 'vacio', textContent: destino() === COMPARTIDO ? 'Nadie ha compartido carpetas contigo.' : 'Sin subcarpetas.' }));
  } catch (e) {
    lista.replaceChildren(el('li', { className: 'vacio error', textContent: e.message }));
  }
}

function abrir(nuevas) {
  migas = nuevas;
  localStorage.setItem(K_DESTINO, JSON.stringify(migas));
  listar();
}

function pintarMigas() {
  const nav = $('migas');
  nav.replaceChildren(
    ...migas.flatMap((m, i) => [
      i ? el('span', { className: 'sep', textContent: '›', ariaHidden: 'true' }) : null,
      i === migas.length - 1 ? el('strong', { textContent: m.nombre }) : el('button', { type: 'button', textContent: m.nombre, onclick: () => abrir(migas.slice(0, i + 1)) }),
    ]).filter(Boolean),
  );
  const virtual = destino() === COMPARTIDO;
  $('soltar').classList.toggle('apagado', virtual);
  $('archivos').disabled = virtual;
  $('nueva').hidden = virtual;
  $('a-donde').textContent = virtual ? 'Entra en una de las carpetas para subir ahí' : 'Se subirán a «' + destino().nombre + '»';
}

async function crearCarpeta(nombre) {
  const d = await post(`${destino().base}/children`, { name: nombre, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  abrir([...migas, carpeta(d)]);
}

// ── Vía: directa o por el relevo ─────────────────────────────────────────────

const via = { modo: 'auto', actual: 'directo', probada: 0, prueba: null };

function put(t, url, blob, inicio, total, por) {
  return new Promise((ok) => {
    const x = new XMLHttpRequest();
    t.xhr = x;
    x.open('PUT', por === 'relay' ? config.relay : url);
    if (por === 'relay') x.setRequestHeader('x-upload-url', url);
    x.setRequestHeader('content-range', `bytes ${inicio}-${inicio + blob.size - 1}/${total}`);
    x.upload.onprogress = (e) => (t.enviado = inicio + e.loaded);
    x.onload = () => ok({ status: x.status, body: leerJSON(x.responseText) });
    x.onerror = x.onabort = x.ontimeout = () => ok({ status: 0 });
    x.send(blob);
  });
}
const leerJSON = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * Carrera entre las dos vías con 3,75 MB en dos sesiones de usar y tirar (no
 * se completan, así que no crean archivo). Gana la que termina antes; si
 * ninguna acaba en 8 s, el relevo, que es el que salva las horas malas.
 */
async function probarVias() {
  const tareas = [{}, {}];
  // Un nombre por sesión: dos a la vez con el mismo nombre dan 409 a veces.
  const sesiones = await Promise.all(['directo', 'relay'].map((n) => post(`${destino().base}:/.segovia-prueba-${n}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } })));
  const blob = new Blob([new Uint8Array(12 * 327680)]);
  const t0 = performance.now();
  const carrera = ['directo', 'relay'].map((por, i) =>
    put(tareas[i], sesiones[i].uploadUrl, blob, 0, blob.size * 4, por).then((r) => {
      if (r.status !== 202) throw new Error();
      return { por, ms: performance.now() - t0 };
    }),
  );
  const gana = await Promise.any([...carrera, dormir(8000).then(() => ({ por: 'relay' }))]).catch(() => ({ por: 'directo' }));
  for (const t of tareas) t.xhr?.abort();
  for (const s of sesiones) fetch(s.uploadUrl, { method: 'DELETE' }).catch(() => {});
  return gana;
}

async function elegirVia() {
  if (!config.relay || via.modo === 'directo') return (via.actual = 'directo');
  if (via.modo === 'relay') return (via.actual = 'relay');
  if (Date.now() - via.probada < 10 * 60e3) return via.actual;
  via.prueba ??= (async () => {
    $('estado').textContent = 'Probando qué vía va más rápido…';
    const r = await probarVias().catch((e) => ({ por: config.relay ? 'relay' : 'directo', error: e.message }));
    via.actual = r.por;
    via.probada = Date.now();
    via.nota = r.error
      ? `No se ha podido probar qué vía va mejor (${r.error}): va por Cloudflare.`
      : r.ms
        ? `Va ${r.por === 'relay' ? 'por Cloudflare' : 'directo a Microsoft'}: ha ganado la prueba (${fmt.format(r.ms / 1000)} s).`
        : 'Va por Cloudflare: la prueba directa no ha acabado ni en 8 s.';
  })().finally(() => (via.prueba = null));
  await via.prueba;
  return via.actual;
}

// ── Cola de subida ───────────────────────────────────────────────────────────

const tareas = [];
let activas = 0;
let lote = null; // { inicio, fin, bytes }: para el resumen al acabar

function añadir(files) {
  if (destino() === COMPARTIDO) return;
  const dest = destino();
  for (const f of files) {
    const trozos = $('trocear').checked ? partes(f.size) : [[0, f.size]];
    trozos.forEach(([a, b], i) => {
      const nombre = trozos.length > 1 ? nombreParte(f.name, i) : f.name;
      const t = {
        nombre, blob: trozos.length > 1 ? f.slice(a, b) : f, size: b - a, dest,
        clave: K_SUBIDA + [dest.base, nombre, b - a, f.lastModified].join('|'),
        estado: 'cola', enviado: 0, vel: 0, prev: 0,
      };
      t.fila = fila(t);
      tareas.push(t);
      $('cola').append(t.fila.li);
    });
  }
  arrancar();
}

async function arrancar() {
  if (!tareas.some((t) => t.estado === 'cola')) return;
  await elegirVia();
  if (!activas && (!lote || lote.fin)) lote = { inicio: performance.now(), bytes: 0 };
  while (activas < PARALELO) {
    const t = tareas.find((t) => t.estado === 'cola');
    if (!t) break;
    activas++;
    t.estado = 'subiendo';
    subir(t)
      .catch((e) => {
        if (t.estado !== 'cancelada') (t.estado = 'error'), (t.error = e.message);
      })
      .finally(() => {
        activas--;
        pintar(t);
        arrancar();
      });
  }
  pintarTodo();
}

async function sesion(t) {
  const guardada = leer(localStorage, t.clave);
  if (guardada && Date.parse(guardada.exp) > Date.now()) {
    // Subida a medias de otra vez: se sigue donde se quedó.
    const r = await fetch(guardada.url).catch(() => null);
    if (r?.ok) {
      t.offset = esperado(await r.json());
      t.reanudada = t.offset > 0;
      return guardada.url;
    }
  }
  const s = await post(`${t.dest.base}:/${encodeURIComponent(t.nombre)}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } });
  localStorage.setItem(t.clave, JSON.stringify({ url: s.uploadUrl, exp: s.expirationDateTime }));
  t.offset = 0;
  return s.uploadUrl;
}

async function subir(t) {
  if (t.size === 0) {
    t.item = await g(`${t.dest.base}:/${encodeURIComponent(t.nombre)}:/content`, { method: 'PUT', body: '' });
    return (t.estado = 'hecha');
  }
  t.url = await sesion(t);
  t.inicio = performance.now();
  t.desde = t.offset; // si se reanuda, la media cuenta solo lo subido ahora
  let fallos = 0;
  while (t.estado === 'subiendo') {
    const por = via.actual;
    const fin = Math.min(t.offset + TROZO[por], t.size);
    const r = await put(t, t.url, t.blob.slice(t.offset, fin), t.offset, t.size, por);
    if (t.estado !== 'subiendo') return;
    if (r.status === 200 || r.status === 201) {
      t.item = r.body;
      t.enviado = t.size;
      t.fin = performance.now();
      lote.bytes += t.size - t.desde;
      localStorage.removeItem(t.clave);
      return (t.estado = 'hecha');
    }
    if (r.status === 202) {
      t.offset = esperado(r.body) || fin;
      fallos = 0;
      continue;
    }
    // Ha fallado: se pregunta a Microsoft por dónde va y se sigue de ahí.
    if (++fallos > 8) throw new Error(`Microsoft no acepta el trozo (${r.status || 'sin conexión'}).`);
    if (por === 'relay' && fallos >= 2 && via.actual === 'relay') {
      via.actual = 'directo';
      via.nota = 'El relevo de Cloudflare falla (¿cupo diario agotado?): sigue directo a Microsoft.';
    }
    await dormir(Math.min(2 ** fallos, 30) * 1000);
    const s = await fetch(t.url).catch(() => null);
    if (s?.status === 404) {
      localStorage.removeItem(t.clave);
      t.url = await sesion(t);
    } else if (s?.ok) t.offset = esperado(await s.json());
  }
}

function cancelar(t) {
  if (t.estado === 'subiendo' || t.estado === 'cola') {
    t.estado = 'cancelada';
    t.xhr?.abort();
    if (t.url) fetch(t.url, { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem(t.clave);
  }
  t.fila.li.remove();
  tareas.splice(tareas.indexOf(t), 1);
  pintarTodo();
}

// ── Enlaces ──────────────────────────────────────────────────────────────────

async function enlace(t, tipo, extra = {}) {
  const d = await post(`/drives/${t.item.parentReference.driveId}/items/${t.item.id}/createLink`, { type: tipo, scope: 'anonymous', ...extra });
  return d.link.webUrl;
}
const segovia = async (t) => location.origin + toPath(await enlace(t, 'view'));
const PARA = { segovia, view: (t) => enlace(t, 'view'), edit: (t) => enlace(t, 'edit') };

/** Copia un texto que aún se está pidiendo a Microsoft, sin perder el permiso del clic. */
function copiar(boton, texto) {
  const original = boton.textContent;
  const marcar = (s, clase) => {
    boton.textContent = s;
    boton.classList.add(clase);
    setTimeout(() => ((boton.textContent = original), boton.classList.remove(clase)), 1800);
  };
  boton.classList.add('pensando');
  const hecho = typeof ClipboardItem === 'function'
    ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': texto.then((s) => new Blob([s], { type: 'text/plain' })) })])
    : texto.then((s) => navigator.clipboard.writeText(s));
  hecho
    .then(() => marcar('Copiado', 'hecho'), (e) => (marcar('Error', 'fallo'), aviso(e.message)))
    .finally(() => boton.classList.remove('pensando'));
  return texto;
}

const aviso = (s) => ($('estado').textContent = s);

// ── Pintar ───────────────────────────────────────────────────────────────────

function icono(nombre) {
  const d = {
    carpeta: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
    gente: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 19c0-3 2.7-5 6-5s6 2 6 5zm13.5 0c0-1.8-.7-3.3-1.9-4.3 2.9-.4 5.4 1.3 5.4 4.3z',
  }[nombre];
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path fill="currentColor" d="${d}"/>`;
  return s;
}

function fila(t) {
  const barra = el('i');
  const info = el('span', { className: 'info' });
  const boton = (texto, para, titulo, clase = '') =>
    el('button', { type: 'button', className: 'chip ' + clase, textContent: texto, title: titulo, onclick: (e) => copiar(e.currentTarget, PARA[para](t)) });
  const caduca = el('input', { type: 'date', min: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
  const clave = el('input', { type: 'text', placeholder: 'Contraseña', autocomplete: 'off', spellcheck: false });
  const opciones = el('details', { className: 'opciones' },
    el('summary', { textContent: 'Caducidad y contraseña' }),
    el('div', {},
      el('label', {}, 'Caduca el ', caduca),
      el('button', { type: 'button', className: 'chip', textContent: 'Poner caducidad y copiar', onclick: (e) => caduca.value && copiar(e.currentTarget, enlace(t, 'view', { expirationDateTime: new Date(caduca.value + 'T23:59:59').toISOString() })) }),
    ),
    el('p', { className: 'nota', textContent: 'Microsoft da un solo enlace de «puede ver» por archivo: la caducidad se aplica a ese, y por tanto también al de Segovia.' }),
    el('div', {},
      clave,
      el('button', { type: 'button', className: 'chip', textContent: 'Copiar enlace con contraseña', onclick: (e) => clave.value && copiar(e.currentTarget, enlace(t, 'view', { password: clave.value })) }),
    ),
    el('p', { className: 'nota', textContent: 'El de contraseña es un enlace aparte, solo de 1drv.ms: Segovia no puede abrirlo.' }),
  );
  const enlaces = el('div', { className: 'enlaces' },
    el('span', { className: 'etiqueta', textContent: 'Copiar enlace:' }),
    boton('Segovia', 'segovia', 'El enlace de Segovia: embed en Discord y descarga directa', 'principal'),
    boton('1drv · puede ver', 'view', 'El enlace de OneDrive de solo lectura'),
    boton('1drv · puede editar', 'edit', 'Cuidado: quien lo tenga puede cambiar o borrar el archivo', 'peligro'),
  );
  const li = el('li', { className: 'fila' },
    el('div', { className: 'fila-cab' },
      el('span', { className: 'nombre-archivo', textContent: t.nombre, title: t.nombre }),
      el('span', { className: 'tam', textContent: tam(t.size) }),
      el('button', { type: 'button', className: 'quitar', ariaLabel: 'Quitar', title: 'Cancelar o quitar de la lista', textContent: '×', onclick: () => cancelar(t) }),
    ),
    el('div', { className: 'barra' }, barra),
    info,
    enlaces,
    opciones,
  );
  return { li, barra, info };
}

function pintar(t) {
  const { li, barra, info } = t.fila;
  li.dataset.estado = t.estado;
  const pc = t.size ? (t.enviado / t.size) * 100 : 100;
  barra.style.width = (t.estado === 'hecha' ? 100 : pc) + '%';
  info.textContent = {
    cola: 'En cola',
    subiendo: `${fmt.format(pc)} %${t.vel ? ' · ' + tam(t.vel) + '/s' : ''}${t.reanudada ? ' · reanudada' : ''}`,
    hecha:
      (t.fin ? `Subida en ${tiempo((t.fin - t.inicio) / 1000)} · media ${tam((t.size - t.desde) / ((t.fin - t.inicio) / 1000))}/s` : 'Subida') +
      (t.item?.name && t.item.name !== t.nombre ? ` · como «${t.item.name}» (ya había uno con ese nombre)` : ''),
    error: 'Error: ' + t.error,
    cancelada: 'Cancelada',
  }[t.estado];
}

function pintarTodo() {
  for (const t of tareas) pintar(t);
  const vivas = tareas.filter((t) => t.estado === 'subiendo' || t.estado === 'cola');
  const total = vivas.reduce((s, t) => s + t.size, 0);
  const hecho = vivas.reduce((s, t) => s + t.enviado, 0);
  const vel = vivas.reduce((s, t) => s + t.vel, 0);
  $('canal').hidden = !vivas.length;
  $('agua').style.width = total ? (hecho / total) * 100 + '%' : '0';
  if (vivas.length) {
    $('vel').textContent = tam(vel) + '/s';
    $('falta').textContent = `${fmt.format(total ? (hecho / total) * 100 : 0)} %${vel ? ' · quedan ' + tiempo((total - hecho) / vel) : ''}`;
    aviso(`${tam(hecho)} de ${tam(total)}. ${via.nota ?? ''}`);
  } else if (lote?.bytes) {
    lote.fin ??= performance.now();
    const s = (lote.fin - lote.inicio) / 1000;
    aviso(`Todo subido: ${tam(lote.bytes)} en ${tiempo(s)}, a una media de ${tam(lote.bytes / s)}/s. ${via.nota ?? ''}`);
  } else aviso(tareas.length ? via.nota ?? '' : '');
  $('lote').hidden = tareas.filter((t) => t.estado === 'hecha').length < 2;
}

function pintarSesion() {
  const dentro = !!leer(sessionStorage, K_SESION);
  $('fuera').hidden = dentro;
  $('dentro').hidden = !dentro;
  if (!dentro) return;
  g('/me/drive')
    .then((d) => ($('quien').textContent = `${d.owner?.user?.displayName ?? 'Tu cuenta'} · ${tam(d.quota.remaining)} libres`))
    .catch(() => {});
  listar();
}

// ── Arranque ─────────────────────────────────────────────────────────────────

function iniciar() {
  config = leerJSON($('config')?.textContent) ?? {};
  if (!config.clientId) return; // instancia sin app de Microsoft (Workers): no hay subida
  document.documentElement.classList.add('con-subida');

  // Se recuerda la última carpeta; la raíz y «Compartido conmigo» se comparan por identidad.
  migas = (leer(localStorage, K_DESTINO) ?? [RAIZ]).map((m) => [RAIZ, COMPARTIDO].find((r) => r.base === m.base) ?? m);
  pintarSesion();

  // Subidas a medias de otra visita.
  const ahora = Date.now();
  let medias = 0;
  for (const k of Object.keys(localStorage).filter((k) => k.startsWith(K_SUBIDA))) {
    if (Date.parse(leer(localStorage, k)?.exp) > ahora) medias++;
    else localStorage.removeItem(k);
  }
  if (medias) aviso(`Hay ${medias} subida${medias > 1 ? 's' : ''} a medias: elige otra vez los mismos archivos, en la misma carpeta, y seguirán donde se quedaron.`);
  if (!config.relay) $('vias').hidden = true;

  $('entrar').onclick = () =>
    entrar()
      .then(pintarSesion)
      .catch((e) => ($('error-entrar').textContent = e.message));
  $('salir').onclick = () => {
    sessionStorage.removeItem(K_SESION);
    pintarSesion();
  };
  $('archivos').onchange = (e) => {
    añadir([...e.target.files]);
    e.target.value = '';
  };
  const zona = $('soltar');
  zona.ondragover = (e) => (e.preventDefault(), zona.classList.add('encima'));
  zona.ondragleave = () => zona.classList.remove('encima');
  zona.ondrop = (e) => {
    e.preventDefault();
    zona.classList.remove('encima');
    añadir([...e.dataTransfer.files]);
  };
  // Un archivo soltado fuera de la zona no debe abrirse en la pestaña.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => e.preventDefault());

  $('nueva').onclick = () => {
    $('nueva').hidden = true;
    $('form-nueva').hidden = false;
    $('nombre-nueva').focus();
  };
  $('form-nueva').onsubmit = (e) => {
    e.preventDefault();
    const nombre = $('nombre-nueva').value.trim();
    const cerrar = () => (($('form-nueva').hidden = true), ($('nueva').hidden = false), ($('nombre-nueva').value = ''));
    if (!nombre) return cerrar();
    crearCarpeta(nombre).then(cerrar, (err) => aviso(err.message));
  };
  $('nombre-nueva').onkeydown = (e) => {
    if (e.key !== 'Escape') return;
    $('nombre-nueva').value = '';
    $('form-nueva').requestSubmit();
  };

  // Cambiar de vía vale también para lo que ya está subiendo: se nota en el siguiente trozo.
  for (const r of document.querySelectorAll('input[name=via]'))
    r.onchange = () => {
      via.modo = r.value;
      via.probada = 0;
      via.nota = r.value === 'auto' ? null : `Va ${r.value === 'relay' ? 'por Cloudflare' : 'directo a Microsoft'}, elegido a mano.`;
      if (r.value !== 'auto' || activas) elegirVia();
    };
  for (const b of document.querySelectorAll('[data-todos]'))
    b.onclick = () => copiar(b, Promise.all(tareas.filter((t) => t.estado === 'hecha').map(PARA[b.dataset.todos])).then((l) => l.join('\n')));

  // La velocidad: media móvil de lo enviado en cada segundo.
  setInterval(() => {
    for (const t of tareas) {
      const delta = Math.max(0, t.enviado - t.prev);
      t.prev = t.enviado;
      t.vel = t.estado === 'subiendo' ? t.vel * 0.7 + delta * 0.3 : 0;
    }
    if (activas || tareas.length) pintarTodo();
  }, 1000);
  addEventListener('beforeunload', (e) => activas && e.preventDefault());
}

if (globalThis.document) iniciar();
