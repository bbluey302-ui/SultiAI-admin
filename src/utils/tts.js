import * as Speech from 'expo-speech';
import { Platform } from 'react-native';
import { CHARACTER_VOICES, characterLocale, resolveCharacterKey } from '../lib/characters';
import { sanitizeForSpeech } from './speech';

const IS_WEB = Platform.OS === 'web';

// Speech used to be synthesized server-side and fetched as an MP3 from
// `${BASE_URL}/audio/tts/*.mp3`. Every cloud provider that route used is gone:
// Edge TTS now 403s non-residential IPs, Deepgram's `POST /v1/text-to-speech`
// 404s for this key, and OpenRouter's `deepgram/flux-tts:free` model has been
// delisted. `expo-speech` is now the primary path rather than the fallback, so
// there is no HTTP fetch, no MP3 and no server URL left in this file.
//
// The web decodeAudioData helpers below still exist: expo-speech on web routes
// through the browser's SpeechSynthesis API, and `playTtsUrl` stays exported
// for any caller that still has a real audio URL (e.g. user-recorded audio).

let player = null;
let listener = null;
let currentToken = 0;
let muted = false;

let webAudio = null;
let audioCtx = null;
let activeBufferSource = null;
let ttsAbortCtl = null;
let fallbackGuardTimer = null;

function getAudioCtx() {
  if (!audioCtx && typeof window !== 'undefined') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

// Unlock the shared web AudioContext from within a user gesture. The greeting
// orb tile fires on a tap; calling this there puts the context in 'running'
// state so decodeAudioData playback is audible — the same path the Test Sound
// beep already proved works on the phone.
export function unlockWebAudio() {
  if (typeof window === 'undefined') return;
  const ctx = getAudioCtx();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

// True when the web AudioContext exists and is 'running' — i.e. audio can be
// produced right now without needing a fresh user gesture. After the user taps
// "Start Voice" (which unlocks the context) this lets the greeting play
// immediately on mount instead of being deferred until another tap.
export function webAudioReady() {
  if (typeof window === 'undefined') return false;
  const ctx = getAudioCtx();
  return !!(ctx && ctx.state === 'running');
}

const ttsDebugSubs = new Set();

export function onTtsDebug(fn) {
  ttsDebugSubs.add(fn);
  return () => ttsDebugSubs.delete(fn);
}

function notifyWeb(msg) {
  if (typeof window !== 'undefined') {
    try {
      const cb = window.__sultiTtsLog;
      if (typeof cb === 'function') cb(msg);
    } catch {}
  }
  ttsDebugSubs.forEach((fn) => {
    try {
      fn(msg);
    } catch {}
  });
}

function getPlayer() {
  if (!player) {
    const { createAudioPlayer } = require('expo-audio');
    player = createAudioPlayer(null);
  }
  return player;
}

export function getAudioPlayer() {
  if (IS_WEB) {
    return {
      setAudioSamplingEnabled: () => {},
      addListener: () => ({ remove: () => {} }),
      removeListener: () => {},
      pause: () => {},
      play: () => {},
      replace: () => {},
      seekTo: () => {},
    };
  }
  return getPlayer();
}

export function setTTSMuted(value) {
  muted = !!value;
  console.log('[TTS] Muted state set to:', muted);
}

export function isTTSMuted() {
  return muted;
}

function stopActiveWebSource() {
  // Halt a BufferSourceNode that is already sounding so navigation away from
  // the voice screen never leaves audio bleeding into the next screen.
  if (activeBufferSource) {
    try {
      activeBufferSource.stop();
    } catch {}
    try {
      activeBufferSource.disconnect();
    } catch {}
    activeBufferSource = null;
  }
}

export function stopTTS() {
  currentToken++;
  // Cancel any in-flight TTS audio fetch
  if (ttsAbortCtl) {
    try {
      ttsAbortCtl.abort();
    } catch {}
    ttsAbortCtl = null;
  }
  // Stop a BufferSourceNode that is already playing
  stopActiveWebSource();
  // Clear the expo-speech fallback watchdog
  if (fallbackGuardTimer) {
    clearTimeout(fallbackGuardTimer);
    fallbackGuardTimer = null;
  }
  if (IS_WEB) {
    if (webAudio) {
      webAudio.pause();
      webAudio.currentTime = 0;
      webAudio = null;
    }
  } else {
    try {
      if (player) {
        if (listener) {
          player.removeListener(listener);
          listener = null;
        }
        player.pause();
        player.seekTo(0);
      }
    } catch {}
  }
  Speech.stop();
}

/**
 * On-device synthesis via `expo-speech`. This is the only TTS path now, so the
 * old "fallback" framing is gone — but the name is kept because the watchdog
 * timer below and every call site were written around it.
 *
 * `language` wins when the caller knows the target language (WhisperAIScreen
 * passes `fil`, PronunciationScreen passes `ceb`). Otherwise the character's own
 * locale is used, so picking "Lola" in Settings actually sounds different.
 */
function speakFallback(clean, { language, rate, pitch, voice, onStart, onDone, onError }) {
  const locale = language || characterLocale(voice);
  notifyWeb('speech synthesis: ' + locale);
  console.log('[TTS] Synthesizing on device with locale', locale, 'for:', clean.substring(0, 30));
  fallbackGuardTimer = setTimeout(
    () => {
      fallbackGuardTimer = null;
      notifyWeb('speech timed out');
      console.log('[TTS] Speech timed out');
      if (onDone) onDone();
    },
    Math.min(20000, 2500 + clean.length * 110)
  );
  const finishFb = () => {
    if (fallbackGuardTimer) {
      clearTimeout(fallbackGuardTimer);
      fallbackGuardTimer = null;
    }
    console.log('[TTS] Speech completed');
    if (onDone) onDone();
  };
  Speech.speak(clean, {
    language: locale,
    rate,
    pitch,
    onStart: () => {
      console.log('[AUDIO] speech-synthesis started');
      if (onStart) onStart();
    },
    onDone: finishFb,
    onError: (error) => {
      console.error('[TTS] Speech error:', error);
      if (fallbackGuardTimer) {
        clearTimeout(fallbackGuardTimer);
        fallbackGuardTimer = null;
      }
      if (onError) onError();
    },
  });
}

function playWebDecoded(audioUri, token, { done, failed, started }, retryCount = 0) {
  console.log('[TTS] === playWebDecoded CALLED ===');
  const ctx = getAudioCtx();
  if (!ctx) {
    console.error('[TTS] No AudioContext available');
    failed();
    return;
  }
  console.log('[TTS] Playing via decodeAudioData (Android-audible path)');
  console.log('[TTS] Audio URI:', audioUri);
  console.log('[TTS] Retry attempt:', retryCount);
  console.log('[TTS] AudioContext state:', ctx.state);
  notifyWeb('decodeAudioData play: ' + audioUri);

  // Ensure context is running
  if (ctx.state === 'suspended') {
    console.log('[TTS] AudioContext suspended, attempting to resume...');
    ctx
      .resume()
      .then(() => {
        console.log('[TTS] AudioContext resumed successfully');
      })
      .catch((err) => {
        console.error('[TTS] Failed to resume AudioContext:', err);
        notifyWeb('AudioContext resume FAILED: ' + err.message);
      });
  }

  // Cancel any previous in-flight fetch so its buffered audio never resolves
  if (ttsAbortCtl) {
    try {
      ttsAbortCtl.abort();
    } catch {}
  }
  ttsAbortCtl = new AbortController();

  console.log('[TTS] Starting fetch for audio...');
  fetch(audioUri, { signal: ttsAbortCtl.signal })
    .then((r) => {
      console.log('[TTS] === FETCH RESPONSE RECEIVED ===');
      console.log('[TTS] Fetch response status:', r.status, r.statusText);
      console.log('[TTS] Response headers:', Object.fromEntries(r.headers.entries()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      notifyWeb('fetch ok ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => {
      console.log('[TTS] === AUDIO BUFFER RECEIVED ===');
      console.log('[TTS] Audio buffer size:', buf.byteLength, 'bytes');
      if (buf.byteLength === 0) {
        throw new Error('Empty audio buffer received');
      }
      notifyWeb('fetched ' + buf.byteLength + ' bytes');
      console.log('[TTS] Starting audio decode...');
      return ctx.decodeAudioData(buf);
    })
    .then((decoded) => {
      console.log('[TTS] === AUDIO DECODED SUCCESSFULLY ===');
      if (token !== currentToken) {
        console.log('[TTS] Token mismatch, aborting playback');
        return;
      }
      if (ctx.state !== 'running') {
        console.error('[TTS] AudioContext not running at play time — audio will be inaudible');
        console.log('[TTS] Current AudioContext state:', ctx.state);
        notifyWeb('NOT RUNNING at play time');
        failed();
        return;
      }
      console.log('[TTS] Audio decoded successfully, playing...');
      console.log('[TTS] Audio duration:', decoded.duration, 'seconds');
      console.log('[TTS] Audio channels:', decoded.numberOfChannels);
      console.log('[TTS] Audio sample rate:', decoded.sampleRate);
      stopActiveWebSource();
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      activeBufferSource = src;
      src.onended = () => {
        console.log('[TTS] === AUDIO PLAYBACK FINISHED ===');
        if (activeBufferSource === src) activeBufferSource = null;
        if (token !== currentToken) return;
        console.log('[TTS] decode audio finished');
        notifyWeb('decode audio finished');
        done();
      };
      src.start(0);
      console.log('[TTS] === AUDIO PLAYBACK STARTED ===');
      notifyWeb('decode audio started');
      if (started) started();
    })
    .catch((e) => {
      console.log('[TTS] === AUDIO PLAYBACK ERROR ===');
      if (e && e.name === 'AbortError') {
        console.log('[TTS] Request was aborted');
        return;
      }
      console.error('[TTS] decodeAudioData failed:', e.message);
      console.error('[TTS] Full error:', e);
      console.error('[TTS] Error stack:', e.stack);
      notifyWeb('decode failed: ' + e.message);
      
      // Retry logic for network errors
      if (retryCount < 2 && (e.message.includes('network') || e.message.includes('fetch'))) {
        console.log('[TTS] Retrying audio fetch (attempt', retryCount + 1, ')');
        setTimeout(() => {
          if (token === currentToken) {
            playWebDecoded(audioUri, token, { done, failed, started }, retryCount + 1);
          }
        }, 1000 * (retryCount + 1));
        return;
      }
      
      if (token !== currentToken) return;
      failed();
    });
}

function playSourceOnNative(uri, { onStart, onDone, onError } = {}) {
  console.log('[TTS] === playSourceOnNative CALLED ===');
  console.log('[TTS] URI:', uri);
  
  // Force the media/loudspeaker route before playback. Recording sets
  // allowsRecording:true, which leaves the audio session on the
  // earpiece/communication path and can make TTS inaudible afterwards.
  if (Platform.OS !== 'web') {
    try {
      console.log('[TTS] Setting audio mode for native playback');
      const { setAudioModeAsync } = require('expo-audio');
      setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    } catch {}
  }
  notifyWeb('[AUDIO] loading: ' + uri);
  const p = getPlayer();
  try {
    p.pause();
    p.seekTo(0);
  } catch {}
  if (listener) {
    try {
      p.removeListener(listener);
    } catch {}
    listener = null;
  }
  let started = false;
  listener = p.addListener('playbackStatusUpdate', (status) => {
    console.log('[TTS] Native audio status update:', JSON.stringify(status));
    if (!status) return;
    if (status.error) {
      console.warn('[AUDIO] === NATIVE PLAYBACK ERROR ===');
      console.warn('[AUDIO] playback error:', status.error);
      notifyWeb('[AUDIO] playback error: ' + status.error);
      if (listener) {
        try {
          p.removeListener(listener);
        } catch {}
        listener = null;
      }
      if (onError) onError();
      return;
    }
    if (status.didJustFinish) {
      console.log('[AUDIO] === NATIVE PLAYBACK FINISHED ===');
      if (listener) {
        try {
          p.removeListener(listener);
        } catch {}
        listener = null;
      }
      console.log('[AUDIO] playback finished');
      notifyWeb('[AUDIO] playback finished');
      if (onDone) onDone();
      return;
    }
    if (!started && status.isLoaded) {
      started = true;
      console.log('[AUDIO] === NATIVE AUDIO LOADED ===');
      console.log('[AUDIO] loaded, starting playback');
      notifyWeb('[AUDIO] loaded, starting playback');
      p.play();
      console.log('[AUDIO] === NATIVE PLAYBACK STARTED ===');
      console.log('[AUDIO] playback started');
      notifyWeb('[AUDIO] playback started');
      if (onStart) onStart();
    }
  });
  try {
    console.log('[TTS] Loading audio into native player');
    p.replace({ uri });
  } catch (e) {
    console.warn('[TTS] === NATIVE PLAYER REPLACE FAILED ===');
    console.warn('[TTS] Audio player replace failed:', e.message);
    notifyWeb('[AUDIO] replace failed: ' + e.message);
    if (!started && listener) {
      try {
        p.removeListener(listener);
      } catch {}
      listener = null;
    }
    if (onError) onError();
  }
}

/**
 * Plays audio that already exists as a URL or data/blob URI.
 *
 * The server used to hand back relative paths like `/audio/tts/<hash>.mp3`,
 * which were resolved against `BASE_URL`. There is no server now, so relative
 * paths cannot be resolved and are rejected outright rather than being turned
 * into a broken URL that would silently never play.
 *
 * Still used for real audio the app owns: recorded clips and any future
 * Supabase Storage URL. `VoiceModeScreen` calls this with `tts_url`, which is
 * now always null, and falls back to `speakTTS`.
 */
export function playTtsUrl(url, { onStart, onDone, onError } = {}) {
  if (!url) {
    if (onError) onError();
    return;
  }
  const isAbsolute = /^https?:/i.test(url) || url.startsWith('blob:') || url.startsWith('data:');
  if (!isAbsolute) {
    console.warn('[TTS] Ignoring relative audio URL, there is no media server:', url);
    if (onError) onError();
    return;
  }
  const token = ++currentToken;

  console.log('[TTS] playTtsUrl called with:', url);
  console.log('[TTS] IS_WEB:', IS_WEB);

  if (IS_WEB) {
    if (webAudio) {
      webAudio.pause();
      webAudio.currentTime = 0;
      webAudio = null;
    }

    // Use decodeAudioData directly for better browser compatibility
    playWebDecoded(url, token, {
      started: () => {
        console.log('[TTS] playTtsUrl playback started');
        if (onStart) onStart();
      },
      done: () => {
        console.log('[TTS] playTtsUrl completed successfully');
        if (onDone) onDone();
      },
      failed: () => {
        console.error('[TTS] playTtsUrl failed to play');
        if (onError) onError();
      },
    }, 0);
    return;
  }

  playSourceOnNative(url, {
    onStart: () => {
      console.log('[TTS] playTtsUrl playback started');
      if (onStart) onStart();
    },
    onDone,
    onError,
  });
}

export function speakTTS(
  text,
  { voice = 'blessica', rate, pitch, language, onStart, onDone, onError } = {}
) {
  const clean = sanitizeForSpeech(text);
  if (!clean) {
    console.log('[TTS] No text to speak after sanitization');
    if (onDone) onDone();
    return;
  }
  console.log('[TTS] === TTS REQUEST STARTED ===');
  console.log('[TTS] text:', clean.substring(0, 100));
  console.log('[TTS] voice:', voice);
  console.log('[TTS] rate:', rate);
  console.log('[TTS] language:', language);
  console.log('[TTS] muted:', muted);
  console.log('[TTS] platform:', IS_WEB ? 'web' : 'native');

  const token = ++currentToken;
  let finished = false;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (token !== currentToken) return;
    if (err) {
      console.log('[TTS] speakTTS finished with error', err);
      if (onError) onError();
    } else {
      console.log('[TTS] speakTTS finished successfully');
      if (onDone) onDone();
    }
  };

  if (muted) {
    console.log('[TTS] Skipping playback due to mute state');
    const simulatedMs = Math.min(3000, 500 + clean.length * 55);
    setTimeout(() => finish(), simulatedMs);
    return;
  }

  // The rate/pitch the caller asked for wins; when a caller passes neither, the
  // character's own defaults apply so picking a character in Settings is
  // audible rather than cosmetic.
  const character = CHARACTER_VOICES[resolveCharacterKey(voice)];

  speakFallback(clean, {
    language,
    rate: rate ?? character.rate,
    pitch: pitch ?? character.pitch,
    voice,
    onStart: () => {
      if (onStart) onStart();
    },
    onDone: () => finish(),
    onError: () => finish(),
  });
}

export function speakTTSPromise(text, opts = {}) {
  return new Promise((resolve) => {
    speakTTS(text, {
      ...opts,
      onDone: () => resolve(true),
      onError: () => resolve(false),
    });
  });
}
