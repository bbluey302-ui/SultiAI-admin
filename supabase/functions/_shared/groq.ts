// Ported from `server/src/utils/groq.ts` + `server/src/utils/fetchRetry.ts`
// to Deno, for use in Supabase Edge Functions.
//
// Behaviour is deliberately identical to the Express implementation so the
// tutor replies, lesson JSON and transcriptions stay the same. Two deliberate
// differences are marked CHANGE below.
//
// The GROQ_API_KEY lives in a Supabase secret (set via `supabase secrets set`)
// and is never present in the APK. That is the whole point of this file.

const GROQ_URL = 'https://api.groq.com/openai/v1';

function env(name: string, fallback = ''): string {
  // CHANGE: Deno.env.get replaces process.env in the Edge runtime.
  return Deno.env.get(name) ?? fallback;
}

// CHANGE: the Express version captured these at module load. Reading per call
// means a redeployed secret takes effect without a cold start.
const groqApiKey = () => env('GROQ_API_KEY');
const chatModel = () => env('GROQ_MODEL', 'openai/gpt-oss-120b');
// CHANGE: the Express version sent chat completions to the text-only
// `openai/gpt-oss-120b` for image analysis, which could not accept images, so
// AR image analysis never worked. Vision now gets its own model default.
const visionModel = () => env('GROQ_VISION_MODEL', 'meta-llama/llama-4-scout-17b-16e-instruct');

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqOptions {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const REASONING_MODELS = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
]);

// The reasoning models emit <reasoning>/<thinking> blocks, and some route them
// to `reasoning_content` instead of `content`. Both have to be stripped or the
// learner's chat bubble renders raw chain-of-thought.
function normalizeOutput(raw: string): string {
  return raw
    .replace(/<\/?thinking>/g, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
    .trim();
}

export function isGroqConfigured(): boolean {
  return !!groqApiKey();
}

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayFor(attempt: number, base: number, max: number): number {
  return Math.min(max, base * Math.pow(2, attempt));
}

function isRetryableNetworkError(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string; message?: string };
  const code = e?.cause?.code || e?.code;
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EADDRNOTAVAIL'
  ) {
    return true;
  }
  return /fetch failed/i.test(String(e?.message || ''));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.min(10000, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(10000, Math.max(0, date - Date.now()));
  return null;
}

export interface FetchWithRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatus?: (status: number) => boolean;
}

/**
 * CHANGE: `init` may be a factory. The Express version replayed one RequestInit
 * across retries, which works for a JSON string body but breaks for FormData —
 * the stream is already consumed by the second attempt. Passing a factory lets
 * the audio upload rebuild its body on every try.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit | (() => RequestInit),
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryOnStatus =
    options.retryOnStatus ?? ((status: number) => status === 429 || status >= 500);

  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const requestInit = typeof init === 'function' ? init() : init;

    let res: Response;
    try {
      res = await fetch(url, requestInit);
    } catch (err) {
      lastErr = err;
      if (!isRetryableNetworkError(err) || attempt >= retries) throw err;
      await sleep(delayFor(attempt, baseDelayMs, maxDelayMs));
      continue;
    }

    if (!retryOnStatus(res.status) || attempt >= retries) return res;

    try {
      res.body && res.body.cancel();
    } catch {
      /* body already consumed; nothing to release */
    }
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    await sleep(retryAfter ?? delayFor(attempt, baseDelayMs, maxDelayMs));
  }

  throw lastErr ?? new Error('fetchWithRetry exhausted retries');
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function groqChat(
  messages: GroqMessage[],
  options: GroqOptions = {}
): Promise<string> {
  const key = groqApiKey();
  if (!key) throw new Error('No LLM configured: set GROQ_API_KEY');

  const model = chatModel();
  const isReasoningModel = REASONING_MODELS.has(model);

  const res = await fetchWithRetry(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      ...(isReasoningModel ? { reasoning_effort: options.reasoningEffort ?? 'low' } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message;

  let content: string = message?.content || message?.reasoning_content || '';
  content = normalizeOutput(content);

  if (!content) throw new Error('Groq returned empty content for the given request');

  return content;
}

/**
 * JSON-mode helper. Every caller in the Express code wrapped this in a
 * try/catch that fell back to plain groqChat + JSON.parse, so keep that
 * contract: this throws on unparseable output and callers decide what next.
 */
export async function groqJson<T>(
  systemPrompt: string,
  userContent: string,
  options: GroqOptions = {}
): Promise<T> {
  const content = await groqChat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    { temperature: options.temperature ?? 0.1, maxTokens: options.maxTokens ?? 500 }
  );

  return parseLooseJson<T>(content);
}

/**
 * JSON.parse with the three repairs an LLM output needs in practice:
 * a ```json fence, a stray prose preamble, and smart quotes. The Express code
 * only handled the fence case and gave up otherwise; this is strictly better
 * and keeps the same output shape.
 */
export function parseLooseJson<T>(content: string): T {
  const candidates: string[] = [];

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const firstBrace = content.indexOf('{');
  const firstBracket = content.indexOf('[');
  if (firstBrace !== -1 || firstBracket !== -1) {
    const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
    const closer = content[start] === '{' ? '}' : ']';
    const end = content.lastIndexOf(closer);
    if (end > start) candidates.push(content.slice(start, end + 1));
  }

  candidates.push(content);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      try {
        return JSON.parse(candidate.replace(/[\u201C\u201D]/g, '"')) as T;
      } catch {
        /* try the next candidate */
      }
    }
  }

  throw new Error(`Failed to parse LLM JSON response: ${content.substring(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

/**
 * `whisper-large-v3` on Groq. The client always uploads 16-bit mono WAV (see
 * `encodeWavBase64` in src/services/voiceAgent.js), so the RIFF sniff below
 * always wins in practice — but m4a/webm/mp3 are still accepted.
 */
export async function groqTranscribeAudio(
  audioBase64: string,
  filename = 'recording.m4a',
  mimeType = 'audio/mp4'
): Promise<string> {
  const key = groqApiKey();
  if (!key) throw new Error('No STT configured: set GROQ_API_KEY');

  // CHANGE: the Express version hand-built a multipart body from Node Buffers
  // with an explicit boundary. Deno has native FormData/Blob, and letting the
  // runtime set the boundary avoids the off-by-one class of bug that hand-built
  // boundaries are prone to.
  const bytes = base64ToBytes(audioBase64);

  const res = await fetchWithRetry(
    `${GROQ_URL}/audio/transcriptions`,
    () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes], { type: mimeType }),
        filename
      );
      form.append('model', env('GROQ_STT_MODEL', 'whisper-large-v3'));
      form.append('response_format', 'json');
      return {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      };
    },
    { retries: 2 }
  );

  if (!res.ok) {
    throw new Error(`Groq Whisper error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data?.text ?? '';
}

/**
 * Detects the container format from the base64 prefix, matching the sniff the
 * Express server did. WAV (RIFF) and ID3-tagged MP3 have recognisable base64
 * headers; anything else is treated as webm/opus.
 *
 *   'UklGR' -> base64('RIFF')  -> WAV
 *   'SUk'   -> base64('#ID3')  -> MP3 with an ID3 tag
 */
export function sniffAudioMime(base64: string): { filename: string; mimeType: string } {
  const head = base64.slice(0, 8);
  if (head.startsWith('Ukl')) return { filename: 'recording.wav', mimeType: 'audio/wav' };
  if (head.startsWith('SUk')) return { filename: 'recording.mp3', mimeType: 'audio/mpeg' };
  if (head.startsWith('G')) return { filename: 'recording.webm', mimeType: 'audio/webm' };
  return { filename: 'recording.m4a', mimeType: 'audio/mp4' };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x4000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export async function groqVision(
  imageBase64: string,
  scenarioContext: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const key = groqApiKey();
  if (!key) throw new Error('Vision requires GROQ_API_KEY');

  const res = await fetchWithRetry(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: visionModel(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Identify the main objects visible in this image that are relevant to: ${scenarioContext}. Return ONLY a JSON array of strings like ["object1","object2"]. Max 10 objects.`,
            },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq Vision error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}
