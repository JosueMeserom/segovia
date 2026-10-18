<p align="center">
  <img src="assets/icon.svg" width="120" alt="Segovia">
</p>

# 🏛️ Segovia

Convierte enlaces compartidos de OneDrive en **enlaces estables al archivo original**: el vídeo se reproduce dentro de Discord, la imagen se ve entera y lo demás se descarga directamente, sin pasar por la web de Microsoft.

Y al revés: **sube archivos a tu OneDrive desde la portada**, mucho más rápido que la web de Microsoft, y te da el enlace para compartirlos.

El nombre viene del [acueducto de Segovia](https://es.wikipedia.org/wiki/Acueducto_de_Segovia): casi dos mil años llevando agua de la sierra a la ciudad, piedra sobre piedra y sin argamasa. Segovia lleva tus archivos desde OneDrive hasta Discord o el navegador, sin quedarse con nada por el camino. Es hermano de [Bayeux](https://github.com/JosueMeserom/bayeux), que cose las imágenes de los posts de X como el tapiz.

---

## 🤔 El problema

Cuando pegas un enlace compartido de OneDrive en Discord, sale una tarjeta genérica de Microsoft. Al abrirlo, una página de OneDrive con su propio visor. El archivo original está ahí, pero no hay ningún enlace estable que lleve a él:

```
          1drv.ms/v/c/...                    Segovia
  ┌──────────────────────────┐   ┌──────────────────────────┐
  │ Microsoft OneDrive       │   │ > el vídeo, en el chat   │
  │ "Echa un vistazo a..."   │   │   con su miniatura       │
  └──────────────────────────┘   └──────────────────────────┘
     una tarjeta y una web          el archivo original
```

La URL directa al archivo existe, pero caduca en una hora. Guardarla no sirve, así que Segovia la pide a Microsoft en cada visita.

---

## 🚀 Cómo se usa

Cambia `1drv.ms` por el host donde tengas Segovia. El `?e=…` del final sobra:

```
https://1drv.ms/v/c/8cf2e82e4f98b498/IQCpdMbC…?e=urd1Zz
https://segovia.example.net/v/c/8cf2e82e4f98b498/IQCpdMbC…
```

O pégalo en la portada, que lo convierte y te deja elegir el modo.

- Si quien entra es un **bot de previews** (Discord, Telegram, Slack, WhatsApp, Mastodon…), recibe un HTML mínimo con las meta etiquetas: `og:video` con miniatura, `og:image` u `og:audio`.
- Si es una **persona con navegador**, recibe un reproductor mínimo para vídeo y audio, la imagen sola, o la descarga directa si es cualquier otra cosa.
- Con `/raw` delante de la ruta, **siempre el archivo**, sin página.

| Parámetro | Qué hace |
|---|---|
| `?m=redirect` | Fuerza el modo redirect para este enlace |
| `?m=proxy` | Fuerza el modo proxy para este enlace |
| (nada) | El de la instancia (`DEFAULT_MODE`), y si no hay, redirect |

Los enlaces del formato antiguo (`1drv.ms/x/s!…`) se convierten igual. Los de `onedrive.live.com/?cid=…&authkey=…` van enteros en base64url bajo `/u/…`; la portada lo hace sola.

---

## 🔀 Modos

| Modo | Cómo | Cuándo |
|---|---|---|
| **Redirect** | Un `302` a la URL directa de Microsoft. Los bytes van de Microsoft a quien mira. | Lo normal. No gasta nada del servidor. |
| **Proxy** | Los bytes pasan por el servidor, en streaming, reenviando `Range` e `If-Range`. Se devuelven `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag` y `Last-Modified`, y `Content-Disposition: attachment` pasa a `inline`. | Cuando algo se empeña en descargar en vez de reproducir, o para saltar en vídeos largos pasada la hora. |

Las meta etiquetas para bots apuntan **siempre en redirect**, aunque el enlace lleve `?m=proxy`. Discord se baja el vídeo entero desde sus servidores antes de mostrarlo, porque muchos MP4 llevan el índice al final, y abandona a los ~10 segundos. Desde Microsoft le llega a tiempo; a través del proxy dependería de la subida del servidor. El `attachment` del redirect no le molesta. El modo elegido sí se respeta en el reproductor de la página y en `/raw`.

En proxy, cada petición con `Range` usa la URL directa que haya en caché. Si Microsoft responde `401`/`403` porque acaba de caducar, se resuelve otra vez y se reintenta una sola vez. Si quien mira cierra el vídeo, se corta también la descarga a Microsoft.

---

## 🗺️ Rutas

| Ruta | Qué devuelve |
|---|---|
| `/` | La portada, con el conversor |
| `/{tipo}/c/{cid}/{id}`, `/{tipo}/s!{id}`, `/u/{base64url}` | Página con meta etiquetas y reproductor, o el archivo si no es multimedia y no es un bot |
| `/raw/…` | El archivo, en el modo que toque |
| `/thumb/…` | `302` a la miniatura de 800 px que genera Microsoft. Es el `og:image` de los vídeos, así no se queda caducado en el embed |
| `/relay` | Solo en Workers: el relevo de las subidas (ver más abajo) |

Los enlaces de **«puede editar»** se rechazan con un `403`. La ruta de Segovia es el propio enlace de OneDrive, así que uno de editar daría permiso de escritura a cualquiera que viera el de Segovia. Microsoft dice el tipo de enlace (`/permission` devuelve `read` o `write`), y Segovia lo comprueba al resolver.

---

## 📤 Subir a OneDrive

Si la instancia tiene app de Microsoft (`ONEDRIVE_CLIENT_ID`), la portada muestra una pestaña **Subir a OneDrive**:

- **Inicio de sesión en el navegador**, con OAuth y PKCE, sin secreto. Los tokens viven en el `sessionStorage` de la pestaña: el servidor no los ve nunca.
- **Selector de carpeta**: tu OneDrive y las carpetas que otros comparten contigo (se sube al OneDrive de su dueño y gasta su espacio). Se recuerda la última.
- **Varios archivos a la vez**, arrastrándolos o eligiéndolos, con progreso, velocidad y tiempo restante.
- **Reanudar.** Un trozo que falla se reintenta preguntando a Microsoft por dónde iba. Si se cierra la pestaña, al volver a elegir el mismo archivo en la misma carpeta sigue donde se quedó (la sesión de subida dura unos días).
- **Enlaces al terminar**: el de **Segovia**, el de OneDrive de **«puede ver»** o el de **«puede editar»**, y para varios archivos, todos de golpe. Opcionalmente, caducidad o contraseña.

### Por qué es más rápido

Medido en la misma línea (fibra simétrica de 1 Gbps):

| Cómo | Velocidad |
|---|---|
| Web de OneDrive | ~1,5 MB/s |
| Sesiones de subida de Graph, un archivo | 20–32 MB/s de madrugada, 0,2–0,5 MB/s por la tarde |
| Lo mismo, 8 archivos a la vez | 60 MB/s de madrugada |
| Pasando por un Worker de Cloudflare | 58 MB/s de madrugada, 10–32 MB/s por la tarde |
| Lo mismo, 6 archivos a la vez, por la tarde | 15,7 MB/s (frente a 13,2 con uno solo, a la misma hora) |

De ahí salen las tres decisiones:

1. **Trozos grandes y varios archivos en paralelo** (6). Microsoft solo admite los trozos de un mismo archivo en orden, así que lo que va en paralelo son archivos.
2. **Los archivos de más de 1 GB se pueden trocear** (opcional) en 6 partes, `nombre.001`, `nombre.002`… que suben a la vez. Quien lo descarga abre la `.001` con 7-Zip y lo junta; si el original era `algo.7z`, se extrae directamente como un 7z multivolumen.
3. **El relevo de Cloudflare.** La subida directa a Microsoft desde algunas casas se arrastra a ciertas horas, y la misma subida pasando por Cloudflare no. Antes de empezar, la portada lanza una carrera de unos segundos entre las dos vías y usa la ganadora. El relevo (`/relay` en el Worker) solo reenvía trozos a sesiones de subida de OneDrive personal; la URL de la sesión ya lleva su permiso, así que tampoco ve ningún token. Si falla (por ejemplo, por el cupo diario de Workers), se sigue directo.

### Registrar la app de Microsoft

Hace falta un directorio de Entra: con una cuenta personal sin directorio, el portal da `AADSTS16000`. Se consigue gratis creando una [cuenta gratuita de Azure](https://azure.microsoft.com/free), que pide tarjeta solo para verificar.

1. En [entra.microsoft.com](https://entra.microsoft.com): **Aplicaciones → Registros de aplicaciones → Nuevo registro**.
2. **Tipos de cuenta admitidos: Solo cuentas personales de Microsoft.**
3. **Authentication**: «Agregar URI de redireccionamiento» → **Aplicación de página única (SPA)** → `https://tu-host/` (y `http://localhost:4040/` para desarrollo). Tiene que ser SPA, no «Web»: así el navegador puede canjear el código con PKCE.
4. **Permisos de API → Microsoft Graph → Permisos delegados → `Files.ReadWrite.All`**. Con `Files.ReadWrite` no se llega a las carpetas compartidas contigo.
5. Ningún secreto. Copia el **Id. de aplicación (cliente)** a `ONEDRIVE_CLIENT_ID` en el `.env`.

Al iniciar sesión, Microsoft muestra la app como «sin comprobar». Verificar al editor exige una cuenta de partner de Microsoft, y para uso personal no compensa.

---

## ☁️ Cloudflare Workers

El mismo núcleo funciona en Workers, en el plan gratuito, **solo en modo redirect**. Un vídeo en proxy, con cada salto una petición nueva, se comería el cupo diario. Una petición en modo proxy se manda con un `302` a `PROXY_BASE` (tu instancia propia) con la misma ruta, o se queda en redirect si no hay `PROXY_BASE`.

```bash
# Token de API con la plantilla "Edit Cloudflare Workers", fuera del repo:
export CLOUDFLARE_API_TOKEN=…
npm run deploy:worker
```

`wrangler.toml` publica la portada como estático (`landing/`) y deja `PROXY_BASE` en `[vars]`. Cámbialo por tu host o bórralo.

Microsoft **no bloquea** las IP de Cloudflare: el flujo funciona igual desde un Worker que desde casa.

---

## 🚀 Instalación con pm2

Sin Docker y sin dependencias: solo Node 20.6 o superior.

```bash
git clone https://github.com/JosueMeserom/segovia.git
cd segovia
cp .env.example .env       # y ajusta HOST, PUBLIC_BASE_URL y DEFAULT_MODE
pm2 start ecosystem.config.cjs
pm2 save
```

Un solo proceso en modo fork: casi todo es esperar a Microsoft y pasar bytes, y la caché vive en memoria.

### Comprobación rápida

```bash
curl -A Discordbot http://127.0.0.1:4040/v/c/<cid>/<id>          # meta etiquetas
curl -I "http://127.0.0.1:4040/raw/v/c/<cid>/<id>?m=proxy"       # cabeceras del proxy
```

---

## 🌐 Detrás de un reverse proxy

El proceso escucha **solo en local**, nunca en `0.0.0.0`. Quien expone al exterior es el proxy, que además resuelve el TLS. Las URL absolutas de las meta etiquetas salen de `PUBLIC_BASE_URL`, porque detrás del proxy la petición llega por `http`.

Si el proxy corre en un contenedor (Caddy en CasaOS, por ejemplo), escucha en la puerta de enlace de `docker0` (`172.17.0.1`) en vez de `127.0.0.1`, o no llegará.

### Ejemplo con Caddy

```caddyfile
segovia.example.net {
	reverse_proxy 172.17.0.1:4040
}
```

Sin `encode`: los vídeos ya van comprimidos y lo único que conseguiría es gastar CPU. La portada la sirve el propio proceso, no hace falta `file_server`.

---

## 🔧 Variables de entorno

| Variable | Por defecto | Qué hace |
|---|---|---|
| `HOST` | `127.0.0.1` | Dónde escucha. `172.17.0.1` si el proxy está en Docker |
| `PORT` | `4040` | Puerto |
| `PUBLIC_BASE_URL` | el `Host` de la petición, por `http` | URL pública, para las meta etiquetas |
| `DEFAULT_MODE` | `redirect` | `redirect` o `proxy`, cuando el enlace no lleva `?m=` |
| `PROXY_BASE` | — | Solo en Workers: adónde mandar las peticiones en modo proxy. También es el único origen al que el relevo responde por CORS |
| `ONEDRIVE_CLIENT_ID` | — | El Id. de aplicación de Entra. Sin él no hay pestaña de subir. No es secreto: va al navegador |
| `RELAY_URL` | — | La ruta `/relay` del Worker. Sin ella, todo se sube directo |

---

## 🧩 Cómo funciona por dentro

Las vías documentadas no sirven para enlaces anónimos: `api.onedrive.com` responde `401`, Graph pide token y `onedrive.live.com/download` da `403`. Segovia hace lo mismo que la web de OneDrive cuando abres un enlace sin sesión:

1. **Token anónimo "Badger".** `POST https://api-badgerp.svc.ms/v1.0/token` con el `appId` público de la web de OneDrive. Dura 7 días y se renueva con una hora de margen.
2. **El archivo.** `GET https://my.microsoftpersonalcontent.com/_api/v2.0/shares/u!{base64url(enlace)}/driveitem?$expand=thumbnails` con `Authorization: Badger …` y **`Prefer: autoredeem`**, obligatorio la primera vez que un token abre un enlace (sin él, `403`). Devuelve nombre, tamaño, tipo, dimensiones del vídeo, miniaturas y `@content.downloadUrl`.
3. **La caducidad.** La URL directa lleva un `tempauth` cuyo primer segmento es un JSON legible con `exp`, a una hora vista. Microsoft la acepta unos 5 minutos más; Segovia la deja de usar 5 minutos antes.

La URL directa funciona desde cualquier IP y sin cookies, admite `Range` (`206`) y lleva `Access-Control-Allow-Origin: *`.

El código está en pocas piezas: `src/core.js` (un manejador `Request → Response` con APIs web), `src/node.js` y `src/worker.js` (los adaptadores, de pocas líneas) y `src/relay.js` (el relevo de subidas). La conversión de enlaces vive en `landing/enlace.js` porque la usan el servidor y la portada; la subida entera, en `landing/subir.js`, en el navegador.

---

## ⚠️ Limitaciones

Sin vender humo:

- **Depende de un flujo no documentado.** El token Badger y `autoredeem` son lo que usa la web de OneDrive por dentro. Si Microsoft lo cambia, Segovia deja de resolver hasta que se adapte.
- **Solo OneDrive personal.** Los enlaces de empresa y SharePoint (`*.sharepoint.com`) usan otro flujo, y de momento no están soportados.
- **Solo archivos sueltos.** Un enlace a una carpeta devuelve un error.
- **En redirect, la URL directa caduca en una hora.** Un reproductor que sigue usando la URL a la que le redirigieron puede fallar al saltar pasado ese tiempo. Recargar lo arregla; el modo proxy no tiene el problema.
- **En redirect, Microsoft sirve con `Content-Disposition: attachment`.** Los `<video>`, `<img>` y Discord lo ignoran, pero si abres `/raw` directamente en el navegador se descarga en vez de mostrarse. En proxy se sirve `inline`.
- **El vídeo se sirve tal cual, sin recomprimir.** Si es HEVC (H.265), solo se reproduce donde haya decodificador: Discord y Chrome lo hacen con aceleración por hardware en muchos equipos, pero no en todos.
- **Discord descarga el vídeo por su cuenta** para el embed; los archivos muy grandes pueden quedarse en la miniatura.
- **La caché es por proceso y en memoria.** En Workers, cada instancia aislada tiene la suya, así que la primera visita en cada una pregunta a Microsoft.
- **El proxy no limita a nadie.** En una instancia pública, cualquiera puede gastar tu ancho de banda con enlaces de OneDrive ajenos.
- **Un archivo grande sin trocear va por una sola conexión.** Es una limitación de las sesiones de subida de Microsoft: probado, un trozo fuera de orden da `416` y dos a la vez, `409`. Trocearlo es la única forma de paralelizarlo, y a cambio quien lo recibe necesita 7-Zip o similar para juntar las partes. Unir las partes en la nube tampoco compensa: copiar de OneDrive a OneDrive por un Worker es otra vez una sola conexión (11,7 MB/s medidos), así que subir y unir tarda más que subir el archivo entero por el relevo.
- **El relevo gasta cupo de Workers**: una petición por trozo de 50 MiB, así que las 100 000 diarias del plan gratuito dan para unos 5 TB al día. CORS solo deja usarlo desde tu portada, pero fuera del navegador cualquiera podría mandarle trozos a sesiones de subida de OneDrive suyas.
- **La caducidad cambia el enlace de «puede ver» de siempre.** Microsoft da uno solo por archivo, así que al ponerle fecha también caduca el de Segovia. Los enlaces con contraseña son aparte y Segovia no puede abrirlos.
- **La sesión dura lo que la pestaña**, y Microsoft no renueva más allá de 24 horas sin volver a iniciar sesión. Las subidas en curso no dependen de ella: la URL de cada sesión de subida lleva su propio permiso.

---

## 📋 Pendiente

- **OneDrive de empresa y SharePoint.**
- **Descargar las partes juntas.** Ahora quien recibe un archivo troceado se baja cada parte y las junta con 7-Zip.

---

## 🔒 Privacidad y condiciones

Lo que hace Segovia con tus datos, sin letra pequeña:

- **Al subir**, la sesión de Microsoft se hace en tu navegador y los tokens se quedan en el `sessionStorage` de la pestaña. Los archivos van del navegador a Microsoft, directos o por el relevo de Cloudflare, que reenvía los trozos sin guardarlos ni ver tu sesión. El servidor de Segovia no recibe ni tus archivos ni tus tokens.
- **Al abrir un enlace**, el servidor pregunta a Microsoft por él y guarda la respuesta en memoria unos minutos. El registro de accesos de la instancia apunta la ruta (que contiene el enlace compartido), el código de respuesta y el navegador, para diagnosticar fallos.
- **No hay cookies, cuentas, analítica ni publicidad.** El navegador solo guarda la última carpeta y pestaña elegidas, y las subidas a medias para poder reanudarlas.
- El permiso que pide la app (`Files.ReadWrite.All`) sirve para listar carpetas, subir y crear enlaces, y solo se usa cuando tú lo pides. Puedes retirarlo cuando quieras en [account.live.com/consent/Manage](https://account.live.com/consent/Manage).

Segovia se ofrece tal cual, sin garantías (licencia MIT), y no tiene relación con Microsoft. Eres responsable de lo que subas y compartas.

---

## 🧪 Desarrollo

```bash
npm test     # node:test, sin dependencias
npm start    # servidor local con el .env si existe
```

Los tests cubren la conversión de enlaces en los dos sentidos, la elección del modo, las cabeceras del proxy, la detección del tipo de archivo, la lectura del `tempauth`, la redirección de Workers a la instancia propia, el rechazo de enlaces de editar, qué acepta el relevo y cómo se trocean los archivos.

En `tools/medir-subida.mjs` está el prototipo con el que se midió la subida.

---

## 📄 Licencia

MIT. Puedes verla en [LICENSE](LICENSE).

Segovia no está afiliado, asociado, autorizado ni respaldado por Microsoft. "OneDrive" y sus marcas pertenecen a sus respectivos dueños.
