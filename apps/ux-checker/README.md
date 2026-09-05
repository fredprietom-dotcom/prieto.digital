# Evaluador UX — v2

v2 del evaluador heurístico de `prieto.digital/checker/`. Diferencias principales frente al v1:

- **Evidencia real**: en vez de mandar la URL a ciegas a un webhook de Make.com, esta versión navega el sitio con un navegador headless real (Playwright), toma una captura de página completa, y se la pasa a Claude junto con la imagen. También acepta subir una captura directamente (útil para pantallas privadas o detrás de login).
- **Salida estructurada**: el backend usa `output_config.format` (Zod) de la API de Claude para forzar un JSON válido en vez del parser manual "a prueba de balas" del v1.
- **Sin Make.com**: todo corre en una función serverless propia (`api/analyze.ts`).

## Arquitectura

```
public/index.html   → frontend estático (mismo lenguaje visual del v1)
api/analyze.ts       → función serverless (Vercel): captura + llamada a Claude
```

- **Captura de pantalla**: `playwright-core` + `@sparticuz/chromium` en producción (Vercel/Lambda Linux); el paquete `playwright` completo en desarrollo local (gestiona su propio Chromium).
- **Modelo**: `claude-opus-5` con visión + salida estructurada (`zodOutputFormat`).
- **Rate limiting**: opcional vía Upstash Redis (sliding window, 5 solicitudes / 10 min por IP). Sin las variables de entorno de Upstash, el endpoint funciona pero sin límite — no lo dejes así en producción pública sin al menos ese control, dado que cada solicitud dispara un navegador headless + una llamada a la API de Claude.

## Deploy (Vercel)

1. `vercel link` (o importa el repo desde el dashboard de Vercel, apuntando a `apps/ux-checker` como root directory).
2. Variables de entorno en el proyecto de Vercel:
   - `ANTHROPIC_API_KEY` (obligatoria)
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (recomendadas — [console.upstash.com](https://console.upstash.com), free tier)
3. `vercel deploy --prod`.
4. Apunta `prieto.digital/checker` a este deployment (rewrite/proxy, o reemplaza el HTML actual si migras el dominio completo).

## Desarrollo local

```bash
npm install
npx playwright install chromium   # una sola vez, para el modo local
vercel dev                        # sirve public/ + api/analyze.ts
```

Sin `vercel dev` (por ejemplo en este sandbox), se puede servir `public/` con cualquier servidor estático para iterar la UI; `api/analyze.ts` no correrá sin el runtime de Vercel, pero sí se puede probar por separado (`npx tsc --noEmit` para typecheck).

## Pendientes conocidos / decisiones abiertas

- **Costo por solicitud público**: este es un endpoint sin autenticación que dispara Playwright + Claude Opus 5 en cada evaluación. El rate limit de Upstash mitiga abuso trivial, pero para tráfico real considera además un captcha (Cloudflare Turnstile) antes de lanzar el análisis.
- **Duración de función**: `vercel.json` pide `maxDuration: 60` — en el plan Hobby de Vercel esto puede requerir Fluid Compute habilitado o quedar limitado a menos; ajusta si el deploy lo rechaza.
- **Tier 1 de pago**: el v1 tenía un CTA comentado para un tier pagado (Lemon Squeezy). No se reactivó en esta v2; queda pendiente si se decide monetizar.
