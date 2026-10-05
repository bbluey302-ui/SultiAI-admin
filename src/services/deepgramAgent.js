/**
 * Stub for the Deepgram live-agents bridge. Applies to every platform.
 *
 * There used to be two implementations: a real one in `deepgramAgent.web.js`
 * and this native stub. Both are gone now for three independent reasons:
 *
 *   1. The `@deepgram/agents` SDK is browser-only. It needs a Web Audio mic
 *      worklet and an `AudioContext` player, and its `@deepgram/sdk`
 *      dependency pulls in Node core modules (`zlib`, `stream`, ...) that Metro
 *      cannot resolve for native builds. So it never worked in the APK.
 *   2. The project's DEEPGRAM_API_KEY cannot mint an agent token at all.
 *      `POST /v1/auth/grant` returns 403 {"err_code":"FORBIDDEN",
 *      "err_msg":"Insufficient permissions."} — the key lacks the Agent scope.
 *      The key itself is valid (`GET /v1/projects` succeeds).
 *   3. Making it work natively would mean hand-writing a raw WebSocket PCM
 *      pipeline against the Agent API. That is a large piece of work for a
 *      feature that has never functioned on the target platform.
 *
 * Voice mode therefore uses the `voiceAgent` HTTP transport on every platform:
 * Groq Whisper for speech recognition, Groq for the reply, and on-device
 * `expo-speech` for playback. `agent-token` Edge Function still exposes the
 * `deepgram` action, so granting the key its Agent permission is a
 * server-side-only fix as far as token minting goes.
 *
 * `VoiceModeScreen` guards every Deepgram call behind
 * `isDeepgramLiveSupported()`, which is always false — so those branches are
 * dead code rather than broken. The two throwing helpers exist so a missed
 * guard fails loudly in development instead of silently handing back
 * `undefined`.
 */

export const DEEPGRAM_INPUT_RATE = 48000;
export const DEEPGRAM_OUTPUT_RATE = 24000;

/** The Deepgram agents SDK requires a browser audio stack, so never on native. */
export function isDeepgramLiveSupported() {
  return false;
}

function unsupported() {
  throw new Error(
    'Deepgram live agents are web-only. Guard this call with isDeepgramLiveSupported().'
  );
}

export async function fetchDeepgramAgentConfig() {
  unsupported();
}

export function createDeepgramLiveSession() {
  unsupported();
}
