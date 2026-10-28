# Plaza Galilea: MVP web

Página web de Plaza Galilea (Olivia y Ramón Café, Bulevar Santa Bárbara). Tiene un sistema de reservas, un panel administrativo y un menú digital con QR.

## Cómo correrlo

Requiere **Node.js 22.13 o superior** (usa `node:sqlite`, que viene incluido; no hay que instalar una base de datos).

```bash
npm install
npm start
```

| Página | URL |
| --- | --- |
| Inicio | http://localhost:3000 |
| Reservar | http://localhost:3000/reservar |
| Consultar reserva | http://localhost:3000/reserva |
| Menú (para el QR) | http://localhost:3000/menu |
| Panel administrativo | http://localhost:3000/admin |

Contraseña del panel por defecto: `galilea2026`. **Cámbiala** con la variable de entorno `ADMIN_PASSWORD` antes de publicar.

### Variables de entorno

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `PORT` | Puerto del servidor | `3000` |
| `ADMIN_PASSWORD` | Contraseña del panel | `galilea2026` |
| `WHATSAPP` | WhatsApp del restaurante si no se ha guardado otro en el panel | `573152337931` (315 233 7931) |
| `DATA_DIR` | Carpeta donde se guarda la base de datos (`galilea.db`) | `./data` |

## Flujo de reservas (lo acordado con el dueño)

1. **El cliente** elige día, número de personas y hora en `/reservar`, y deja nombre, celular, y opcionalmente correo y comentarios.
2. Ve **"¡Recibimos tu solicitud!"** con su **código** (ej. `GAL-F29MC`) y el aviso **"Escríbenos por WhatsApp para hacer el pago de tu reserva"**. La reserva queda **Pendiente**.
3. El botón **"Escribir por WhatsApp"** abre el chat del 315 233 7931 con este mensaje listo:
   ```
   Hola, este es mi código de reserva: GAL-F29MC
   Quiero confirmar mi reserva para hacer el pago.

   Fecha: Viernes, 30 de octubre, 7:30 p. m.
   Personas: 3
   Nombre: Laura Gómez
   ```
4. **El restaurante** entra al panel (`/admin`). La reserva aparece en **"Por confirmar"** (suena un aviso cuando llega una nueva). Cobra el abono por WhatsApp y toca **"Pago recibido · Confirmar"**; puede anotar la referencia del pago.
5. La reserva queda **Confirmada · ✓ Pagada**. El cliente lo ve en `/reserva` con su código, y desde la fila el restaurante puede escribirle por WhatsApp con un mensaje de confirmación ya listo.

### Disponibilidad

- En **Panel → Disponibilidad** se ve cada hora del día con cuántas reservas y personas tiene.
- Toca una hora para marcarla como **llena**: el cliente ya no puede reservar en esa hora. Tócala de nuevo para abrirla.
- **"Marcar todo el día lleno"** cierra el día completo.
- Opcional: en **Configuración → Máx. reservas por hora** se puede poner un límite automático. Con 0 no hay límite y todo se maneja a mano.
- Las reservas **pendientes y confirmadas** ocupan cupo; las canceladas lo liberan.

### Otras reglas

- Un mismo celular no puede tener dos reservas activas el mismo día. Si lo intenta, se le muestra el código que ya tiene.
- Para grupos más grandes que el máximo configurado, se le pide escribir por WhatsApp.
- El panel se actualiza solo cada 20 segundos y avisa cuando entra una reserva nueva.

## Configuración (Panel → Configuración)

- **WhatsApp del restaurante**: viene cargado el 315 233 7931 (`573152337931`). Si se borra, el botón del cliente lleva a los mensajes directos de Instagram.
- **Dirección pública**: la URL donde quede publicada la página (ej. `https://galileaplaza.com`). El QR del menú se genera con esta dirección.
- **Horario de reservas**: primera y última hora en que se puede reservar cada día. Se puede cerrar un día completo.
- Intervalo entre horas, anticipación mínima, días a futuro y máximo de personas.

> El horario que viene cargado (12:00 m. a 9:00 o 10:00 p. m.) es **provisional**: no estaba publicado. Hay que ajustarlo con el dueño.

## Menú y QR

- El menú está en [`public/data/menu.json`](public/data/menu.json), transcrito del PDF "Menú Galilea plaza" que tienen enlazado en Instagram. Para cambiar platos o precios se edita ese archivo; no hace falta reiniciar.
- En **Panel → Menú QR** se descarga el QR general en PNG o se genera una hoja para imprimir con un QR por mesa (`/qr-mesas.html`). El QR de cada mesa abre el menú mostrando "Mesa N".

## Estructura

```
server.js              API y servidor de archivos
lib/store.js           Base de datos SQLite (reservas, bloqueos, configuración)
lib/availability.js    Cálculo de horas disponibles
lib/time.js            Fechas en hora de Colombia (UTC-5)
public/                Páginas (HTML, CSS y JS sin compilación)
public/data/menu.json  Contenido del menú
data/galilea.db        Base de datos (se crea sola; no se sube a git)
```

## Para publicarlo

Sirve cualquier hosting que corra Node y tenga disco persistente (Railway, Render con disco, un VPS, etc.):

1. Define `ADMIN_PASSWORD` y, si el disco persistente está en otra ruta, `DATA_DIR`.
2. `npm install && npm start`.
3. En el panel, escribe la **dirección pública** y el **WhatsApp**, y vuelve a imprimir los QR.

## Pendiente para una siguiente versión

- Que las reservas pendientes sin pago se cancelen solas después de X horas.
- Registrar reservas tomadas por teléfono desde el panel.
- Notificaciones al restaurante por WhatsApp o correo cuando entra una reserva.
- Usuarios separados para el panel (hoy hay una sola contraseña compartida).
- Editar el menú desde el panel.
