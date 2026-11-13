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
- **Selector de carpeta**: tu OneDrive, tus accesos directos y lo compartido contigo (se sube al OneDrive de su dueño y gasta su espacio, así que cada carpeta compartida enseña cuánto le queda). Con **buscador**, que mira también dentro de lo compartido, y un campo para **pegar el enlace** de una carpeta. Se recuerda la última.
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

## 🔑 Acceso por ID, para otros programas

Opcional, y solo en una instancia propia. Da a otros programas tuyos (un addon, un script) acceso a **una carpeta** de tu OneDrive sin compartir nada con enlaces: listar, comprobar, crear sesiones de subida y servir archivos por ID con una URL estable. A diferencia de la pestaña de subir, aquí el servidor sí guarda una sesión de Microsoft, la de quien instala la instancia.

**Instalación:**

1. En la app de Entra del apartado anterior: **Authentication → Configuración → Permitir flujos de clientes públicos → Sí**.
2. Inicia sesión con la cuenta que tiene acceso a la carpeta. Te pedirá que abras una web de Microsoft y escribas un código:
   ```bash
   npm run segovia login
   ```
3. Elige la carpeta y crea una clave por programa. Cada clave se enseña una sola vez:
   ```bash
   npm run segovia raiz "Mi carpeta/Sub"          # tuya, o un acceso directo a una compartida
   npm run segovia raiz https://1drv.ms/f/…       # o con el enlace de la carpeta
   npm run segovia clave addon                    # solo lee
   npm run segovia -- clave script --escritura    # además puede subir
   pm2 restart segovia
   ```

Se guarda en `~/.config/segovia/` (o `SEGOVIA_DIR`), fuera del repo y con permisos 600. El refresh token de Microsoft rota: se guarda de forma atómica en cada renovación y se renueva cada 12 horas aunque nadie use nada, y si falla, avisa con `AVISO_CMD`. `npm run segovia revocar addon` quita una clave al momento y `npm run segovia rotar-firma` invalida las URL ya repartidas.

| Ruta | Qué hace |
|---|---|
| `GET /api/lista?ruta=…[&profundo=1]` | Carpetas y archivos, con su URL de reproducción firmada |
| `GET /api/archivo?ruta=…` | Si existe, con su tamaño y descripción |
| `PATCH /api/archivo` `{ruta, descripcion}` | Guarda un texto en la descripción del archivo. Usa `clave=valor;`: Microsoft escapa comillas y llaves |
| `POST /api/subida` `{ruta, tamano, reemplazar?}` | La `uploadUrl` para subir por trozos; Segovia no toca los bytes. Crea las carpetas que falten, y avisa si no cabe o si ya existe |
| `POST /api/pruebas/caducar` `{id?}` | Estropea la URL de descarga guardada, para probar la renovación sin esperar una hora |
| `GET`/`HEAD /id/<id>/<firma>/<nombre>[?m=redirect]` | El archivo, sin clave: la firma vale para ese archivo y nada más |

Las claves van en `Authorization: Bearer …`, y todas las rutas son relativas a la carpeta elegida: `..` no sale de ella.

**El servido por ID va en proxy** salvo que pidas `?m=redirect`, y aguanta lo que un reproductor no sabría arreglar:

- Si la URL de Microsoft caduca, pide otra y repite el mismo rango.
- Si la conexión se corta o se queda sin datos, sigue desde el mismo byte.
- **Elige servidor de Microsoft.** Desde una misma casa medimos 90 MB/s hacia unos y 0,5 hacia otros, y el DNS reparte con rachas de un minuto entero hacia los lentos. Cada instancia recuerda cuál le ha ido bien y evita el que le ha ido mal; los rápidos los guarda en `servidores.json` y los sigue usando aunque el DNS pase días sin darlos. Si esperando a Microsoft llegan menos de `PROXY_MIN_MBS` y la conexión no va a más, cambia de conexión (cada una acelera durante muchos segundos, y cambiarla antes es volver a empezar); un reproductor que lee despacio porque no necesita más no dispara nada.
- **Si lo lento es la ruta entera hasta Microsoft, usa el relevo.** Medido a la vez y contra el mismo servidor: 0,9 MB/s en directo y 55 por Cloudflare. Con `RELAY_URL` puesto, una conexión directa lenta hace que durante una hora pida el archivo al relevo (el mismo Worker de las subidas, con `GET` y la URL de descarga en `x-download-url`); si el relevo falla o también va lento, vuelve a lo directo. La URL de descarga lleva su propio permiso y caduca en una hora: la sesión de la cuenta sigue sin salir del servidor.

Nada de esto corre en el Worker, que no importa estos módulos: el token no sale del servidor.

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
| `RELAY_URL` | — | La ruta `/relay` del Worker. Sin ella, todo se sube directo y el servido por ID no tiene por dónde esquivar una ruta lenta a Microsoft |
| `SEGOVIA_DIR` | `~/.config/segovia` | Dónde se guardan la sesión y las claves del acceso por ID |
| `AVISO_CMD` | — | Comando que recibe el aviso como último argumento si no se puede renovar la sesión. Sin él, va al registro |
| `PROXY_MIN_MBS` | `10` | MB/s por debajo de los cuales el servido por ID prueba otra conexión. `0` lo apaga |
| `PROXY_SALIDA` | | Dirección IP local desde la que el servido por ID sale hacia Microsoft. Sirve para llevar solo ese tráfico por un túnel cuando la ruta del proveedor a Microsoft va mal (medido: 0,9 MB/s directo y 50 por el túnel, a la vez). Si la salida falla, vuelve a la conexión normal durante diez minutos |

---

## 🧩 Cómo funciona por dentro

Las vías documentadas no sirven para enlaces anónimos: `api.onedrive.com` responde `401`, Graph pide token y `onedrive.live.com/download` da `403`. Segovia hace lo mismo que la web de OneDrive cuando abres un enlace sin sesión:

1. **Token anónimo "Badger".** `POST https://api-badgerp.svc.ms/v1.0/token` con el `appId` público de la web de OneDrive. Dura 7 días y se renueva con una hora de margen.
2. **El archivo.** `GET https://my.microsoftpersonalcontent.com/_api/v2.0/shares/u!{base64url(enlace)}/driveitem?$expand=thumbnails` con `Authorization: Badger …` y **`Prefer: autoredeem`**, obligatorio la primera vez que un token abre un enlace (sin él, `403`). Devuelve nombre, tamaño, tipo, dimensiones del vídeo, miniaturas y `@content.downloadUrl`.
3. **La caducidad.** La URL directa lleva un `tempauth` cuyo primer segmento es un JSON legible con `exp`, a una hora vista. Microsoft la acepta unos 5 minutos más; Segovia la deja de usar 5 minutos antes.

La URL directa funciona desde cualquier IP y sin cookies, admite `Range` (`206`) y lleva `Access-Control-Allow-Origin: *`.

El código está en pocas piezas: `src/core.js` (un manejador `Request → Response` con APIs web), `src/node.js` y `src/worker.js` (los adaptadores, de pocas líneas) `src/graph.js` y `src/api.js` (la sesión de Microsoft y el acceso por ID, solo en Node) y `src/relay.js` (el relevo de subidas). La conversión de enlaces vive en `landing/enlace.js` porque la usan el servidor y la portada; la subida entera, en `landing/subir.js`, en el navegador.

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
- **En Windows, una subida clavada en unos 2,6 MB/s suele ser cosa del equipo, no de Segovia.** Si `netsh int tcp show global` dice `disabled` en el ajuste automático de ventana de recepción, cada conexión tiene un tope de unos 64 KB en vuelo, así que la velocidad depende de lo lejos que esté el servidor de Microsoft que te toque, en cualquier programa. Medido en un mismo PC, contra un servidor a 24 ms: 2,6 MB/s antes y unos 25 MB/s después de `netsh int tcp set global autotuninglevel=normal` en una terminal de administrador, sin reiniciar. Contra uno a 2,4 ms apenas se notaba (unos 20 MB/s), y por eso parecía ir y venir. Windows lo trae activado de serie.
- **La caducidad cambia el enlace de «puede ver» de siempre.** Microsoft da uno solo por archivo, así que al ponerle fecha también caduca el de Segovia. Los enlaces con contraseña son aparte y Segovia no puede abrirlos.
- **La sesión dura lo que la pestaña**, y Microsoft no renueva más allá de 24 horas sin volver a iniciar sesión. Las subidas en curso no dependen de ella: la URL de cada sesión de subida lleva su propio permiso.
- **La lista de carpetas compartidas no puede ser completa.** Microsoft no da ninguna llamada que las enumere: `sharedWithMe` se apaga a partir de noviembre de 2026 según su documentación, y ya devuelve de menos (en una cuenta con cinco carpetas compartidas, solo una). «Compartido conmigo» junta tus accesos directos, lo que `sharedWithMe` haya dado y los enlaces que hayas pegado, y esos dos últimos se recuerdan solo en ese navegador. Si una carpeta no aparece, búscala por su nombre, pega su enlace o añádele un acceso directo desde la web de OneDrive.
- **Un enlace de solo lectura deja entrar, pero no subir.** La carpeta se abre y el error llega al intentar subir.
- **Cada cuenta tiene su propia cuota.** Lo que subes a una carpeta compartida gasta el espacio de su dueño, no el tuyo. Un plan familiar no es un bloque común: son 1 TB por persona.
- **El acceso por ID sirve una sola carpeta, de una sola cuenta.** Si se llena, hay que elegir otra.

---

## 📋 Pendiente

- **OneDrive de empresa y SharePoint.**
- **Elegir servidor también en el proxy público.** Ahora solo lo hace el servido por ID.
- **Descargar las partes juntas.** Ahora quien recibe un archivo troceado se baja cada parte y las junta con 7-Zip.

---

## 🔒 Privacidad y condiciones

Lo que hace Segovia con tus datos, sin letra pequeña:

- **Al subir**, la sesión de Microsoft se hace en tu navegador y los tokens se quedan en el `sessionStorage` de la pestaña. Los archivos van del navegador a Microsoft, directos o por el relevo de Cloudflare, que reenvía los trozos sin guardarlos ni ver tu sesión. El servidor de Segovia no recibe ni tus archivos ni tus tokens.
- **En el acceso por ID**, que es opcional y solo de quien instala la instancia, el servidor sí guarda el refresh token de esa cuenta, en un archivo con permisos 600 fuera del repo. No sale por la API ni llega al Worker. El registro de accesos apunta el ID del archivo, no la firma.
- **Al abrir un enlace**, el servidor pregunta a Microsoft por él y guarda la respuesta en memoria unos minutos. El registro de accesos de la instancia apunta la ruta (que contiene el enlace compartido), el código de respuesta y el navegador, para diagnosticar fallos.
- **No hay cookies, cuentas, analítica ni publicidad.** El navegador solo guarda la última carpeta y pestaña elegidas, las carpetas compartidas que ha visto y las subidas a medias para poder reanudarlas.
- El permiso que pide la app (`Files.ReadWrite.All`) sirve para listar carpetas, subir y crear enlaces, y solo se usa cuando tú lo pides. Puedes retirarlo cuando quieras en [account.live.com/consent/Manage](https://account.live.com/consent/Manage).

Segovia se ofrece tal cual, sin garantías (licencia MIT), y no tiene relación con Microsoft. Eres responsable de lo que subas y compartas.

---

## 🧪 Desarrollo

```bash
npm test     # node:test, sin dependencias
npm start    # servidor local con el .env si existe
```

Los tests cubren la conversión de enlaces en los dos sentidos, la elección del modo, las cabeceras del proxy, la detección del tipo de archivo, la lectura del `tempauth`, la redirección de Workers a la instancia propia, el rechazo de enlaces de editar, qué acepta el relevo y cómo se trocean los archivos.

`test/api.test.js` prueba el acceso por ID con Microsoft simulado: rutas que no salen de la raíz, claves y firmas, la rotación del refresh token, los avisos, y que el proxy renueve la URL, retome tras un corte y cambie de conexión sin perder ni repetir un byte.

En `tools/medir-subida.mjs` está el prototipo con el que se midió la subida.

---

## 📄 Licencia

MIT. Puedes verla en [LICENSE](LICENSE).

Segovia no está afiliado, asociado, autorizado ni respaldado por Microsoft. "OneDrive" y sus marcas pertenecen a sus respectivos dueños.
