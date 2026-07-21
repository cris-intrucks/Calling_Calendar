# Protocolo de Callback - Retención InTrucks

Automatización de llamadas perdidas del equipo de Retención: detecta la llamada
perdida en RingCentral, notifica al cliente por SMS, recuerda al asesor hacer
el callback (intento 1 a los 15 min, intento 2 a las 2h), y verifica contra el
log real de RingCentral si el contacto ocurrió de verdad -- eso alimenta el
indicador de satisfacción.

## Estado actual

- [x] Repositorio de GitHub
- [x] Proyecto de Supabase + tablas creadas (`db/migrations/001_init.sql`)
- [x] Cuenta de Vercel conectada al repo
- [ ] Environment Variables conectadas en Vercel (siguiente paso, ver abajo)
- [ ] Suscripción de webhook creada en RingCentral apuntando a este proyecto
- [ ] Secrets de GitHub Actions configurados

## 1. Conectar las Environment Variables en Vercel

Ve a **vercel.com → tu proyecto → Settings → Environment Variables** y agrega,
una por una, marcadas para **Production** (y Preview si vas a probar en ramas):

| Variable | De dónde sale |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (secreta, no la `anon`) |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` (esta sí puede ir en el frontend) |
| `RC_CLIENT_ID` | El que ya tienes: `bGuS6tg9TyRfewXziXXR7w` |
| `RC_CLIENT_SECRET` | El que ya tienes de RingCentral |
| `RC_JWT` | El JWT que generaste en el Developer Console |
| `CRON_SECRET` | Inventa un string largo y aleatorio (ej. genera uno con `openssl rand -hex 32`) -- protege los endpoints de cron |

**Importante**: ninguna variable que empiece con `NEXT_PUBLIC_` va aquí -- esas
quedarían visibles en el navegador. Todas las de arriba son solo de backend.

Después de agregarlas, hay que hacer un **redeploy** (Vercel no las aplica a
deployments ya existentes automáticamente).

## 2. Configurar los Secrets de GitHub Actions

En **GitHub → tu repo → Settings → Secrets and variables → Actions**, agrega:

- `VERCEL_APP_URL`: la URL de tu proyecto en producción, ej. `https://retencion-callback.vercel.app`
- `CRON_SECRET`: el mismo valor exacto que pusiste en Vercel

Esto es lo que permite que `.github/workflows/scheduled-triggers.yml` llame a
los endpoints de `/api/cron/*` cada 5-10 minutos sin necesitar plan Pro de Vercel.

## 3. Crear la suscripción de webhook en RingCentral

Una vez desplegado, la URL a registrar como target de la suscripción es:

```
https://<tu-proyecto>.vercel.app/api/webhook/ringcentral
```

Esto se hace con una llamada a la API de suscripciones de RingCentral
(`POST /restapi/v1.0/subscription`) -- avísame cuando tengas la URL de Vercel
lista y armamos ese script.

## ⚠️ Pendiente de validar

El parseo del payload en `api/webhook/ringcentral.js` está construido sobre la
estructura esperada de un evento de `telephony/sessions` con filtro de llamada
perdida, pero **la forma exacta del JSON puede variar** según cómo quede
configurado el filtro de la suscripción. En cuanto la suscripción esté creada
y llegue el primer evento real, hay que revisar el payload real en los logs de
Vercel y ajustar el parseo si es necesario -- esto lo dejamos como el primer
punto a probar en cuanto esté desplegado.

También queda pendiente el envío real del recordatorio interno a Teams
(marcado como `TODO` en `reminder-attempt1.js` y `reminder-attempt2.js`) --
falta definir si va por Microsoft Graph API o un webhook de canal.

## Estructura del repo

```
/api
  /webhook/ringcentral.js     -> recibe la llamada perdida (real-time)
  /cron/reminder-attempt1.js  -> recordatorio a los 15 min
  /cron/reminder-attempt2.js  -> recordatorio a las 2h (si intento 1 falló)
  /cron/verify-calls.js       -> cruza contra el log real + resuelve status
  /cron/renew-subscription.js -> renueva la suscripción antes de vencer
/lib                          -> helpers compartidos (Supabase, RingCentral, auth de cron)
/db/migrations                -> esquema SQL (ya ejecutado en Supabase)
/.github/workflows            -> el "cron" real, vía GitHub Actions
```
