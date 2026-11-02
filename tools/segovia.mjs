#!/usr/bin/env node
/**
 * Prepara el acceso autenticado de la instancia (src/api.js). Con el .env cargado:
 *
 *   npm run segovia login                        inicia sesión en Microsoft con un código
 *   npm run segovia raiz "Carpeta/Sub"           fija la carpeta raíz: tuya o un acceso directo a una compartida
 *   npm run segovia raiz https://1drv.ms/f/…     lo mismo, con el enlace de la carpeta
 *   npm run segovia -- raiz --ids DRIVE ITEM     lo mismo, si ya tienes los ID
 *   npm run segovia clave addon                  crea una clave de solo lectura y la enseña una vez
 *   npm run segovia -- clave script --escritura  crea una que además puede subir
 *   npm run segovia revocar addon                la borra, sin reiniciar nada
 *   npm run segovia rotar-firma                  invalida todas las URL de /id/ ya repartidas
 *
 * Todo se guarda en ~/.config/segovia (o SEGOVIA_DIR), fuera del repo y con permisos 600.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SCOPE, graph, guardar, leer } from '../src/graph.js';

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';
const [orden, ...args] = process.argv.slice(2);
const secreto = () => randomBytes(32).toString('base64url');
const config = () => leer('config.json') ?? {};

async function login() {
  const client_id = process.env.ONEDRIVE_CLIENT_ID;
  if (!client_id) throw new Error('Falta ONEDRIVE_CLIENT_ID en el .env.');
  const r = await fetch(AUTH + 'devicecode', { method: 'POST', body: new URLSearchParams({ client_id, scope: SCOPE }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error === 'invalid_client' ? 'La app no admite este login: activa «Permitir flujos de clientes públicos» en Entra.' : d.error_description);
  console.log(`\nAbre ${d.verification_uri} y escribe este código: ${d.user_code}\nEntra con la cuenta que tiene acceso a la carpeta. Esperando…`);
  for (;;) {
    await new Promise((ok) => setTimeout(ok, d.interval * 1000));
    const t = await fetch(AUTH + 'token', {
      method: 'POST',
      body: new URLSearchParams({ client_id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code }),
    });
    const j = await t.json();
    if (t.ok) {
      guardar('sesion.json', { refresh_token: j.refresh_token, renovado: new Date().toISOString() });
      const yo = await (await graph('/me/drive?$select=owner,quota')).json();
      console.log(`Sesión guardada: ${yo.owner?.user?.displayName}.`);
      return;
    }
    if (j.error !== 'authorization_pending' && j.error !== 'slow_down') throw new Error(j.error_description ?? j.error);
  }
}

async function ok(r) {
  if (!r.ok) throw new Error(`Microsoft responde ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Lee todas las páginas de un listado. */
async function todos(url) {
  const v = [];
  while (url) {
    const d = await ok(await graph(url));
    v.push(...(d.value ?? []));
    url = d['@odata.nextLink'];
  }
  return v;
}

/**
 * Admite un enlace de la carpeta o una ruta. El primer trozo de la ruta se busca
 * en tu raíz, donde están también los accesos directos a carpetas de otras
 * cuentas: esos no se pueden recorrer por ruta (Graph da 422), hay que saltar a
 * su unidad. Lo guardado son los ID, así que renombrar o mover la carpeta no
 * rompe nada y no se depende de sharedWithMe, que Microsoft está retirando.
 */
async function raiz() {
  if (args[0] === '--ids') return { drive: args[1], item: args[2], nombre: args[3] ?? '' };
  if (args[0]?.startsWith('https://')) {
    const compartido = 'u!' + Buffer.from(args[0]).toString('base64url');
    const d = await ok(await graph(`/shares/${compartido}/driveItem?$select=id,name,folder,parentReference`, { headers: { prefer: 'redeemSharingLinkIfNecessary' } }));
    if (!d.folder) throw new Error('Ese enlace no es de una carpeta.');
    return { drive: d.parentReference.driveId, item: d.id, nombre: d.name };
  }
  const trozos = (args[0] ?? '').split('/').filter(Boolean);
  if (!trozos.length) throw new Error('Dime la carpeta: una ruta o un enlace.');
  const campos = '$select=id,name,folder,remoteItem,parentReference';
  let x = (await todos(`/me/drive/root/children?$top=200&${campos}`)).find((y) => y.name === trozos[0]);
  // Compartida sin acceso directo: solo la ve sharedWithMe, mientras responda.
  x ??= (await todos('/me/drive/sharedWithMe?$top=200').catch(() => [])).find((y) => y.name === trozos[0]);
  const r = x?.remoteItem ?? x;
  if (!r?.folder) throw new Error(`No encuentro la carpeta «${trozos[0]}». Añade un acceso directo en OneDrive o usa su enlace.`);
  const drive = r.parentReference.driveId;
  const sub = trozos.slice(1).map(encodeURIComponent).join('/');
  const d = sub ? await ok(await graph(`/drives/${drive}/items/${r.id}:/${sub}`)) : r;
  if (!d.folder) throw new Error(`«${args[0]}» no es una carpeta.`);
  return { drive, item: d.id, nombre: args[0] };
}

const c = config();
switch (orden) {
  case 'login':
    await login();
    break;
  case 'raiz': {
    const r = await raiz();
    guardar('config.json', { ...c, raiz: r, firma: c.firma ?? secreto() });
    console.log(`Raíz fijada: ${r.nombre || r.item}.`);
    break;
  }
  case 'clave': {
    if (!args[0]) throw new Error('Dime para qué cliente es la clave.');
    const clave = secreto();
    const hash = createHash('sha256').update(clave).digest('hex');
    guardar('config.json', { ...c, firma: c.firma ?? secreto(), clientes: { ...c.clientes, [args[0]]: { hash, escribe: args.includes('--escritura') } } });
    console.log(`Clave de ${args[0]} (no se vuelve a mostrar): ${clave}`);
    break;
  }
  case 'revocar': {
    const { [args[0]]: fuera, ...resto } = c.clientes ?? {};
    if (!fuera) throw new Error(`No hay ninguna clave de ${args[0]}.`);
    guardar('config.json', { ...c, clientes: resto });
    console.log(`Clave de ${args[0]} revocada.`);
    break;
  }
  case 'rotar-firma':
    guardar('config.json', { ...c, firma: secreto() });
    console.log('Firma cambiada: las URL de /id/ ya repartidas dejan de valer.');
    break;
  default:
    console.log('Órdenes: login, raiz, clave, revocar, rotar-firma. Detalles al principio de tools/segovia.mjs.');
}
