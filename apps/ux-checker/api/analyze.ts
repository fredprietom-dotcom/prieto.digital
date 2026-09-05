import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Browser } from 'playwright-core';
import { chromium as playwrightCoreChromium } from 'playwright-core';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

/* ══════════════════════════════════════════════════════════
   ESQUEMA DEL REPORTE — debe reflejar exactamente lo que
   espera el frontend (public/index.html → renderReport)
   ══════════════════════════════════════════════════════════ */
const HeuristicaSchema = z.object({
  id: z.number().int().min(1).max(10),
  nombre: z.string(),
  severidad: z.enum(['critico', 'moderado', 'leve', 'ok']),
  hallazgo: z.string(),
  score: z.number().min(0).max(10),
});

const ReportSchema = z.object({
  resumen: z.string(),
  score_general: z.number().min(0).max(10),
  heuristicas: z.array(HeuristicaSchema).length(10),
});

export type Report = z.infer<typeof ReportSchema>;

const NIELSEN_HEURISTICS = [
  'Visibilidad del estado del sistema',
  'Coincidencia entre el sistema y el mundo real',
  'Control y libertad del usuario',
  'Consistencia y estándares',
  'Prevención de errores',
  'Reconocimiento antes que recuerdo',
  'Flexibilidad y eficiencia de uso',
  'Estética y diseño minimalista',
  'Ayuda para reconocer y recuperarse de errores',
  'Ayuda y documentación',
];

const SYSTEM_PROMPT = `Eres un evaluador experto de UX/UI. Se te entrega la captura de pantalla real de un sitio web (viewport de escritorio, página completa). Evalúa el sitio contra las 10 heurísticas de usabilidad de Nielsen Norman, en este orden exacto:

${NIELSEN_HEURISTICS.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Reglas:
- Basa cada hallazgo en evidencia VISIBLE en la captura (elementos, textos, jerarquía, espaciado, estados). No inventes funcionalidad que no puedas ver.
- Si una heurística no aplica o no se puede evaluar por lo que muestra la captura, dilo explícitamente en el hallazgo y usa severidad "ok" con score 7.
- "severidad": "critico" (score 0-3) = rompe la experiencia; "moderado" (score 4-5) = fricción relevante; "leve" (score 6-7) = detalle menor; "ok" (score 8-10) = sin problema.
- "hallazgo": 1-2 frases, concretas, en español, dirigidas al dueño del sitio.
- "resumen": 2-3 frases con el diagnóstico general.
- "score_general": promedio ponderado honesto de las 10 heurísticas (no lo infles).
- Responde SIEMPRE con exactamente 10 heurísticas, ids del 1 al 10 en el orden de la lista.`;

/* ══════════════════════════════════════════════════════════
   RATE LIMITING (best-effort; se salta si Upstash no está configurado)
   ══════════════════════════════════════════════════════════ */
let ratelimit: Ratelimit | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, '10 m'),
    prefix: 'ux-checker',
  });
}

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const ip = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return ip?.trim() || req.socket.remoteAddress || 'unknown';
}

/* ══════════════════════════════════════════════════════════
   CAPTURA DE PANTALLA (Playwright)
   — en Vercel/Lambda usa @sparticuz/chromium (binario liviano
     precompilado para el runtime serverless de Linux);
   — en desarrollo local usa el paquete `playwright` completo,
     que gestiona su propio Chromium (`npx playwright install chromium`).
   ══════════════════════════════════════════════════════════ */
async function launchBrowser(): Promise<Browser> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION);

  if (isServerless) {
    const chromium = (await import('@sparticuz/chromium')).default;
    return playwrightCoreChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }

  const { chromium: fullChromium } = await import('playwright');
  return fullChromium.launch({ headless: true });
}

class SitioInaccesibleError extends Error {}

async function captureScreenshot(url: string): Promise<{ base64: string; mediaType: 'image/png' }> {
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 UXCheckerBot/2.0',
    });
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 25000 });
    } catch (err) {
      throw new SitioInaccesibleError(`No se pudo cargar la URL: ${(err as Error).message}`);
    }

    // deja asentar animaciones/lazy-load antes de la captura
    await page.waitForTimeout(1200);

    const buffer = await page.screenshot({ type: 'png', fullPage: true, timeout: 15000 });
    return { base64: buffer.toString('base64'), mediaType: 'image/png' };
  } finally {
    await browser?.close();
  }
}

/* ══════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════ */
type RequestBody =
  | { mode: 'url'; url: string }
  | { mode: 'image'; image: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' };

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (ratelimit) {
    const { success, reset } = await ratelimit.limit(clientIp(req));
    if (!success) {
      res.setHeader('Retry-After', Math.ceil((reset - Date.now()) / 1000).toString());
      res.status(429).json({ error: 'rate_limited', message: 'Demasiadas evaluaciones. Intenta de nuevo en unos minutos.' });
      return;
    }
  }

  const body = req.body as Partial<RequestBody> | undefined;

  let imageBase64: string;
  let mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  let sourceUrl: string | null = null;

  try {
    if (body?.mode === 'url') {
      if (!body.url || !isValidHttpUrl(body.url)) {
        res.status(400).json({ error: 'invalid_url', message: 'La URL no es válida.' });
        return;
      }
      sourceUrl = body.url;
      const shot = await captureScreenshot(body.url);
      imageBase64 = shot.base64;
      mediaType = shot.mediaType;
    } else if (body?.mode === 'image') {
      if (!body.image || !body.mediaType) {
        res.status(400).json({ error: 'invalid_image', message: 'Falta la imagen a analizar.' });
        return;
      }
      imageBase64 = body.image;
      mediaType = body.mediaType;
    } else {
      res.status(400).json({ error: 'invalid_request', message: "El campo 'mode' debe ser 'url' o 'image'." });
      return;
    }
  } catch (err) {
    if (err instanceof SitioInaccesibleError) {
      res.status(422).json({ error: 'site_unreachable', message: err.message });
      return;
    }
    res.status(500).json({ error: 'capture_failed', message: 'No pudimos capturar el sitio. Intenta de nuevo.' });
    return;
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Evalúa esta interfaz contra las 10 heurísticas de Nielsen y devuelve el reporte estructurado.' },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(ReportSchema) },
    });

    if (!response.parsed_output) {
      res.status(502).json({ error: 'parse_failed', message: 'Claude no devolvió un reporte válido. Intenta de nuevo.' });
      return;
    }

    res.status(200).json({
      url: sourceUrl,
      fecha: new Date().toISOString(),
      screenshot: sourceUrl ? `data:${mediaType};base64,${imageBase64}` : null,
      ...response.parsed_output,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      res.status(503).json({ error: 'upstream_rate_limited', message: 'El servicio de análisis está saturado. Intenta en un momento.' });
      return;
    }
    if (err instanceof Anthropic.APIError) {
      res.status(502).json({ error: 'upstream_error', message: 'El análisis falló. Intenta de nuevo.' });
      return;
    }
    res.status(500).json({ error: 'unknown_error', message: 'Ocurrió un error inesperado.' });
  }
}
