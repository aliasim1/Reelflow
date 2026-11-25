import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

interface ChatMessageInput {
  role: 'user' | 'assistant';
  text: string;
}

interface WorkspaceContextInput {
  activeRole?: string;
  theme?: string;
  platforms?: Array<{
    id: string;
    name: string;
    connected: boolean;
    apiMode: string;
  }>;
  queueSummary?: {
    totalReels: number;
    publishedJobs: number;
    scheduledOrQueued: number;
    needsAttention: number;
  };
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  ur: 'Urdu (اردو script)',
  'roman-ur': 'Roman Urdu (Urdu written in English alphabet)',
  ar: 'Arabic (العربية)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
};

let cachedAiKey = '';
let cachedAiClient: GoogleGenAI | null = null;

function getGeminiClient(apiKey: string): GoogleGenAI {
  if (!cachedAiClient || cachedAiKey !== apiKey) {
    cachedAiKey = apiKey;
    cachedAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedAiClient;
}

function stripControlChars(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Sanitizes history, drops leading assistant greetings, merges consecutive
 * same-role turns so Gemini always receives valid alternating user/model turns,
 * and ensures the final turn is from the user.
 */
function normalizeConversationTurns(raw: unknown): ChatMessageInput[] {
  if (!Array.isArray(raw)) return [];

  const cleaned = raw
    .slice(-14)
    .filter(
      (item): item is { role?: unknown; text?: unknown } =>
        Boolean(item) && typeof item === 'object'
    )
    .map((item) => ({
      role: (item.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      text:
        typeof item.text === 'string'
          ? stripControlChars(item.text).trim().slice(0, 1200)
          : '',
    }))
    .filter((item) => item.text.length > 0);

  // Drop leading assistant messages so Gemini turns always start with 'user'
  const firstUserIdx = cleaned.findIndex((m) => m.role === 'user');
  if (firstUserIdx === -1) return [];

  const merged: ChatMessageInput[] = [];
  for (const msg of cleaned.slice(firstUserIdx)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.text = `${prev.text}\n${msg.text}`.slice(0, 1800);
    } else {
      merged.push({ ...msg });
    }
  }

  // Ensure conversation ends on a user prompt
  while (merged.length > 0 && merged[merged.length - 1].role !== 'user') {
    merged.pop();
  }

  return merged.slice(-12);
}

function sanitizeWorkspaceContext(raw: unknown): WorkspaceContextInput {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;

  const activeRole =
    typeof obj.activeRole === 'string' &&
    ['admin', 'creator', 'editor', 'viewer'].includes(obj.activeRole)
      ? obj.activeRole
      : undefined;

  const theme =
    obj.theme === 'light' || obj.theme === 'dark' ? obj.theme : undefined;

  const platforms = Array.isArray(obj.platforms)
    ? obj.platforms
        .slice(0, 6)
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
        .map((p) => ({
          id: typeof p.id === 'string' ? p.id.slice(0, 24) : 'unknown',
          name: typeof p.name === 'string' ? p.name.slice(0, 40) : 'Channel',
          connected: Boolean(p.connected),
          apiMode: typeof p.apiMode === 'string' ? p.apiMode.slice(0, 24) : 'unknown',
        }))
    : undefined;

  let queueSummary: WorkspaceContextInput['queueSummary'];
  if (obj.queueSummary && typeof obj.queueSummary === 'object') {
    const q = obj.queueSummary as Record<string, unknown>;
    queueSummary = {
      totalReels: Number.isFinite(Number(q.totalReels)) ? Number(q.totalReels) : 0,
      publishedJobs: Number.isFinite(Number(q.publishedJobs)) ? Number(q.publishedJobs) : 0,
      scheduledOrQueued: Number.isFinite(Number(q.scheduledOrQueued))
        ? Number(q.scheduledOrQueued)
        : 0,
      needsAttention: Number.isFinite(Number(q.needsAttention))
        ? Number(q.needsAttention)
        : 0,
    };
  }

  return { activeRole, theme, platforms, queueSummary };
}

function buildSystemInstruction(params: {
  langCode: string;
  currentView: string;
  isAdmin: boolean;
  ctx: WorkspaceContextInput;
}): string {
  const { langCode, currentView, isAdmin, ctx } = params;

  const platformStatusLine = ctx.platforms?.length
    ? ctx.platforms
        .map(
          (p) =>
            `${p.name}: ${p.connected ? `Connected (${p.apiMode})` : 'Disconnected / Setup Needed'}`
        )
        .join('; ')
    : 'Not provided';

  const queueStatusLine = ctx.queueSummary
    ? `Total Reels=${ctx.queueSummary.totalReels}, Published=${ctx.queueSummary.publishedJobs}, Queued/Scheduled=${ctx.queueSummary.scheduledOrQueued}, Needs Attention=${ctx.queueSummary.needsAttention}`
    : 'Not provided';

  return [
    'You are the official ReelFlow Help Assistant inside the ReelFlow short-form video publishing studio.',
    `Always reply in ${LANGUAGE_LABELS[langCode]} unless the user explicitly asks you to reply in a different language.`,
    'Response style: accurate, concise, friendly, and practical. Use short numbered steps (1, 2, 3) when explaining actions, and keep answers under 170 words unless a detailed breakdown is explicitly requested.',
    '',
    'STRICT ACCURACY & ANTI-HALLUCINATION RULES:',
    '- Only reference UI labels, tabs, settings, limits, and behaviors explicitly documented below or present in Live User Context.',
    '- NEVER invent menu names, buttons, analytics charts, pricing tiers, or external credentials.',
    '- If a request cannot be done inside ReelFlow or requires Owner Admin action while the user is not an Admin, state that clearly.',
    '- Never reveal or fabricate private user emails, phone numbers, API keys, or internal system details.',
    '',
    'LIVE USER CONTEXT:',
    `- Current View: "${currentView}"`,
    `- Account Privilege: ${isAdmin ? 'Owner Admin' : 'Standard Creator'}`,
    `- Active Preview Role: ${ctx.activeRole ?? (isAdmin ? 'admin' : 'creator')}`,
    `- Active Theme: ${ctx.theme === 'light' ? 'Bright Blue (light)' : ctx.theme === 'dark' ? 'Dark Blue (dark)' : 'Blue Studio'}`,
    `- Channel Status: ${platformStatusLine}`,
    `- Queue Summary: ${queueStatusLine}`,
    '',
    'VERIFIED REELFLOW PRODUCT SPECIFICATION:',
    '1) Account & Sign-In: Users sign in via Google Sign-In with a verified email, then enter their Display Name and preferred Language to finish onboarding.',
    '2) Language & Theme: Users can change Language (English, Urdu, Roman Urdu, Arabic, Spanish, French) anytime from the top header or sidebar, and toggle between Bright Blue and Dark Blue themes.',
    '3) Upload & Composer Studio (nav: "Upload & Studio"):',
    '   - Formats: MP4, MOV, WebM (or M4V). Vertical 9:16 (1080x1920) is recommended; keep files under 250 MB for smooth mobile upload. Users can also click "Load Sample 9:16 Clip" to test.',
    '   - Cover Frame: Use the "Cover Frame Timestamp" slider below the preview video to capture any frame as the cover.',
    '   - Captions: Write one Shared Caption & Description, insert quick hashtags, or toggle "Customize caption specifically for <Platform>" for per-platform overrides.',
    '   - Platform Limits & Options:',
    '     * TikTok: max 180s, max 2,200 chars; Privacy (Everyone / Friends / Only me), Comments, Duet, Stitch.',
    '     * Instagram Reels: max 90s, max 2,200 chars; option to share cover preview to profile grid.',
    '     * YouTube Shorts: max 60s, max 5,000 chars; Shorts Title (max 100 chars, #Shorts recommended), Visibility (Public / Unlisted / Private).',
    '     * Facebook Reels: max 90s, max 2,200 chars; Audience (Public / Friends), option to also share to Facebook Feed.',
    '     * Twitter / X: max 140s, max 280 chars; Reply permissions (Everyone / Following / Mentioned).',
    '     * Snapchat (Spotlight): max 60s, max 250 chars; Spotlight Topic field.',
    '   - Timing: Choose "Publish Now", "Schedule for Later" (date & time picker), or "Save Draft".',
    '4) Publishing Queue & "Needs API Setup" / "Setup Needed" (nav: "Publishing Queue"):',
    '   - Filter tabs: All Reels, Scheduled, Published, Needs Attention, plus text search by title, caption, or author.',
    '   - If a target shows "Needs API Setup", open "Connected Accounts" / "Channel Status". Owner Admins can click "Connect Sandbox" for safe testing or enter OAuth Client ID + Webhook URL for Live mode, then click "Retry" in the queue.',
    '   - Standard users cannot edit API credentials; they can publish to already-connected channels or ask the workspace Admin to connect the channel.',
    '5) Role Permissions (RBAC):',
    '   - Admin: Full access including Media Channel URLs, User Roles & Team, Connected Accounts/API modes, and WhatsApp & Gmail support settings.',
    '   - Creator: Can upload, compose, publish immediately, schedule, retry/delete, and view channels — cannot edit Admin Panel settings.',
    '   - Editor: Can upload, compose, schedule, and save drafts — CANNOT "Publish Now" immediately and cannot retry/delete or open Admin Panel.',
    '   - Viewer: Read-only access to Dashboard, Queue, and Reel Previews — cannot upload, edit, publish, or retry.',
    '6) Direct Support: Bottom-right floating WhatsApp and Gmail buttons let users reach human support anytime.',
  ].join('\n');
}

function extractSafeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  // Strip any accidental key= query params just in case
  const sanitized = raw.replace(/key=[^&\s"']+/gi, 'key=[REDACTED]');
  const firstBrace = sanitized.indexOf('{');
  const lastBrace = sanitized.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(sanitized.slice(firstBrace, lastBrace + 1)) as {
        error?: { message?: string; status?: string; code?: number };
      };
      if (parsed?.error?.message) {
        const prefix = parsed.error.code
          ? `${parsed.error.code} ${parsed.error.status ?? ''}`.trim()
          : parsed.error.status ?? '';
        return prefix ? `${prefix}: ${parsed.error.message}` : parsed.error.message;
      }
    } catch {
      // Not valid embedded JSON
    }
  }
  return sanitized.slice(0, 260);
}

function classifyGeminiError(err: unknown): {
  status: number;
  message: string;
  retryable: boolean;
  tryFallbackModel: boolean;
} {
  const raw = extractSafeErrorMessage(err);
  const lower = raw.toLowerCase();
  if (
    raw.includes('403') ||
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('API_KEY_INVALID') ||
    lower.includes('api key not valid')
  ) {
    return {
      status: 403,
      message:
        'The AI assistant API key is missing or invalid. Please check GEMINI_API_KEY in Settings > Secrets.',
      retryable: false,
      tryFallbackModel: false,
    };
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Gemini API quota is currently busy for this key. Wait a few seconds and tap Retry, or select another key in Settings > Secrets.',
      retryable: true,
      tryFallbackModel: true,
    };
  }
  if (
    raw.includes('503') ||
    raw.includes('UNAVAILABLE') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('temporarily unavailable')
  ) {
    return {
      status: 503,
      message:
        'The AI model is experiencing temporary high demand. Please wait a few seconds and tap Retry.',
      retryable: true,
      tryFallbackModel: true,
    };
  }
  if (raw.includes('400') || raw.includes('INVALID_ARGUMENT')) {
    return {
      status: 400,
      message: `Could not process request (${raw}). Try rephrasing or starting a New Chat.`,
      retryable: false,
      tryFallbackModel: false,
    };
  }
  if (raw.includes('404') || raw.includes('NOT_FOUND')) {
    return {
      status: 502,
      message: `Assistant model unavailable (${raw}).`,
      retryable: false,
      tryFallbackModel: true,
    };
  }
  return {
    status: 502,
    message: `Assistant request failed: ${raw}`,
    retryable: true,
    tryFallbackModel: true,
  };
}

const CHAT_MODEL_CANDIDATES: Array<{
  model: string;
  thinkingLevel?: ThinkingLevel;
  delayBeforeMs?: number;
}> = [
  { model: 'gemini-3.1-flash-lite' },
  { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW, delayBeforeMs: 250 },
  { model: 'gemini-3.1-flash-lite', delayBeforeMs: 500 },
  { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW, delayBeforeMs: 700 },
];

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runWithModelFallback<T>(
  signal: AbortSignal,
  runner: (
    candidate: { model: string; thinkingLevel?: ThinkingLevel },
    attemptSignal: AbortSignal
  ) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < CHAT_MODEL_CANDIDATES.length; i++) {
    const candidate = CHAT_MODEL_CANDIDATES[i];
    if (i > 0 && candidate.delayBeforeMs) {
      await sleepWithAbort(candidate.delayBeforeMs, signal);
    }
    const perAttemptTimeout = AbortSignal.timeout(7000);
    const attemptSignal = AbortSignal.any([signal, perAttemptTimeout]);
    try {
      return await runner(candidate, attemptSignal);
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      const info = classifyGeminiError(err);
      console.error(
        `[help-chat] attempt ${i + 1} (${candidate.model}) failed:`,
        extractSafeErrorMessage(err)
      );
      const isTimeout =
        err instanceof DOMException &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      if ((!info.tryFallbackModel && !isTimeout) || i === CHAT_MODEL_CANDIDATES.length - 1) {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/help-chat', async (req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        error:
          'Assistant is temporarily unavailable because GEMINI_API_KEY is not configured in Settings > Secrets.',
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = normalizeConversationTurns(body.messages);
    if (messages.length === 0) {
      res.status(400).json({ error: 'Please enter a question to send.' });
      return;
    }

    const langCode =
      typeof body.language === 'string' && body.language in LANGUAGE_LABELS
        ? body.language
        : 'en';
    const currentView =
      typeof body.currentView === 'string'
        ? body.currentView.slice(0, 40)
        : 'dashboard';
    const isAdmin = Boolean(body.isAdmin);
    const workspaceContext = sanitizeWorkspaceContext(body.workspaceContext);
    const wantsStream = body.stream !== false;

    const systemInstruction = buildSystemInstruction({
      langCode,
      currentView,
      isAdmin,
      ctx: workspaceContext,
    });

    const ai = getGeminiClient(apiKey);
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 25_000);
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (!wantsStream) {
      try {
        const response = await runWithModelFallback(
          abortController.signal,
          (candidate, attemptSignal) =>
            ai.models.generateContent({
              model: candidate.model,
              contents,
              config: {
                systemInstruction,
                ...(candidate.thinkingLevel
                  ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
                  : {}),
                abortSignal: attemptSignal,
              },
            })
        );

        const replyText = response.text?.trim();
        if (!replyText) {
          res
            .status(502)
            .json({ error: 'The assistant returned an empty response. Please try again.' });
          return;
        }
        res.json({ reply: replyText });
      } catch (err: unknown) {
        const classified = classifyGeminiError(err);
        res.status(classified.status).json({ error: classified.message });
      } finally {
        clearTimeout(timeoutId);
      }
      return;
    }

    // Streaming SSE response for instant first-token feedback
    let headersSent = false;
    let emittedChars = 0;

    try {
      const stream = await runWithModelFallback(
        abortController.signal,
        (candidate, attemptSignal) =>
          ai.models.generateContentStream({
            model: candidate.model,
            contents,
            config: {
              systemInstruction,
              ...(candidate.thinkingLevel
                ? { thinkingConfig: { thinkingLevel: candidate.thinkingLevel } }
                : {}),
              abortSignal: attemptSignal,
            },
          })
      );

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      headersSent = true;

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        const delta = chunk.text;
        if (delta && delta.length > 0) {
          emittedChars += delta.length;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }

      if (!abortController.signal.aborted) {
        if (emittedChars === 0) {
          res.write(
            `data: ${JSON.stringify({
              error: 'The assistant returned an empty response. Please tap Retry.',
            })}\n\n`
          );
        } else {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        }
      }
      res.end();
    } catch (err: unknown) {
      if (abortController.signal.aborted && res.destroyed) {
        if (!res.writableEnded) res.end();
        return;
      }
      const classified = classifyGeminiError(err);
      if (!headersSent) {
        res.status(classified.status).json({ error: classified.message });
      } else {
        res.write(`data: ${JSON.stringify({ error: classified.message })}\n\n`);
        res.end();
      }
    } finally {
      clearTimeout(timeoutId);
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReelFlow server listening on port ${PORT}`);
  });
}

void startServer();
