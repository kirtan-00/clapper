import type { SpeechCommand, SpeechListener } from '../types';

// --------------------------------------------------------------------------
// Minimal ambient typing for the Web Speech API (absent from TS's DOM lib).
// Only the surface this module touches is declared.
// --------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

// --------------------------------------------------------------------------

const COMMAND_DEBOUNCE_MS = 2000;
const RESTART_BACKOFF_MS = 300;

// Word-boundary matches. "cut it" and "cut cut" both contain a bare "cut",
// so a single \bcut\b covers them; the debounce collapses repeats.
const PATTERNS: Array<{ cmd: SpeechCommand; re: RegExp }> = [
  { cmd: 'action', re: /\baction\b/i },
  { cmd: 'cut', re: /\bcut\b/i },
];

let warnedUnsupported = false;

export function createSpeechListener(): SpeechListener {
  const Ctor: SpeechRecognitionCtor | undefined =
    typeof window !== 'undefined'
      ? window.SpeechRecognition ?? window.webkitSpeechRecognition
      : undefined;

  const supported = Ctor !== undefined;
  if (!supported && !warnedUnsupported) {
    warnedUnsupported = true;
    console.warn('Clapper: Web Speech API not supported; voice commands disabled.');
  }

  const commandCbs = new Set<(cmd: SpeechCommand) => void>();
  const stateCbs = new Set<(listening: boolean) => void>();

  let recognition: SpeechRecognitionLike | null = null;
  let started = false; // logical: start() called, stop() not yet
  let restartTimer: number | null = null;
  let lang = 'en-IN';
  const lastFiredAt: Record<SpeechCommand, number> = { action: 0, cut: 0 };

  const setListening = (value: boolean): void => {
    if (listener.listening === value) return;
    listener.listening = value;
    stateCbs.forEach((cb) => cb(value));
  };

  const clearRestartTimer = (): void => {
    if (restartTimer !== null) {
      window.clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const emit = (cmd: SpeechCommand): void => {
    const now = Date.now();
    if (now - lastFiredAt[cmd] < COMMAND_DEBOUNCE_MS) return;
    lastFiredAt[cmd] = now;
    commandCbs.forEach((cb) => cb(cmd));
  };

  const handleResult = (event: SpeechRecognitionEventLike): void => {
    // Scan only the latest chunk: results from resultIndex onward.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result === undefined || result.length === 0) continue;
      const alternative = result[0];
      if (alternative === undefined) continue;
      const transcript = alternative.transcript;
      for (const { cmd, re } of PATTERNS) {
        if (re.test(transcript)) emit(cmd);
      }
    }
  };

  const tryStart = (): void => {
    if (!started || recognition === null) return;
    try {
      recognition.start();
    } catch {
      // Already started or in a bad state; the browser will fire onend/onerror
      // if the session dies, which schedules another restart attempt.
    }
  };

  const scheduleRestart = (): void => {
    if (!started) return;
    clearRestartTimer();
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      tryStart();
    }, RESTART_BACKOFF_MS);
  };

  const buildRecognition = (): SpeechRecognitionLike | null => {
    if (Ctor === undefined) return null;
    let rec: SpeechRecognitionLike;
    try {
      rec = new Ctor();
    } catch {
      return null;
    }
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onstart = () => {
      setListening(true);
    };

    rec.onresult = (event) => {
      handleResult(event);
    };

    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Permission denied: stop cleanly, no restarts, no throws.
        started = false;
        clearRestartTimer();
        setListening(false);
        return;
      }
      if (event.error === 'language-not-supported' && lang !== 'en-US') {
        // Fall back to en-US and let the onend restart pick it up.
        lang = 'en-US';
        if (recognition !== null) recognition.lang = lang;
      }
      // Other errors (no-speech, network, aborted...) fall through to onend.
    };

    rec.onend = () => {
      setListening(false);
      if (started) {
        // iOS/Chrome kill continuous sessions; restart after a short backoff.
        scheduleRestart();
      }
    };

    return rec;
  };

  const listener: SpeechListener = {
    supported,
    listening: false,

    start(): void {
      if (!supported || started) return;
      started = true;
      if (recognition === null) recognition = buildRecognition();
      if (recognition === null) {
        started = false;
        return;
      }
      tryStart();
    },

    stop(): void {
      started = false;
      clearRestartTimer();
      if (recognition !== null) {
        try {
          recognition.abort();
        } catch {
          // ignore
        }
      }
      setListening(false);
    },

    onCommand(cb: (cmd: SpeechCommand) => void): () => void {
      commandCbs.add(cb);
      return () => {
        commandCbs.delete(cb);
      };
    },

    onStateChange(cb: (listening: boolean) => void): () => void {
      stateCbs.add(cb);
      return () => {
        stateCbs.delete(cb);
      };
    },
  };

  return listener;
}
