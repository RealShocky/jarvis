/**
 * Voice input (Web Speech API) and audio output (AudioContext) for JARVIS.
 *
 * The microphone keeps listening while JARVIS speaks — the server decides what
 * is echo and what is a barge-in. Playback is a strictly ordered queue of
 * chunks; each one is acknowledged to the server when it finishes.
 */

// ---------------------------------------------------------------------------
// Voice Input
// ---------------------------------------------------------------------------

export interface VoiceInput {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
}

const INTERIM_THROTTLE_MS = 200;
const RETRY_MAX_MS = 30000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const webkitSpeechRecognition: any;

export function createVoiceInput(
  onTranscript: (text: string) => void,
  onInterim: (text: string) => void,
  onError: (msg: string) => void
): VoiceInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR = (window as any).SpeechRecognition || (typeof webkitSpeechRecognition !== "undefined" ? webkitSpeechRecognition : null);
  if (!SR) {
    onError("Speech recognition not supported in this browser");
    return { start() {}, stop() {}, pause() {}, resume() {} };
  }

  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let shouldListen = false;
  let paused = false;
  let waitingForRetry = false;
  let retryDelay = 1000;
  let lastInterimAt = 0;
  let pendingInterim: string | null = null;
  let interimFlush: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function emitInterim(text: string) {
    lastInterimAt = Date.now();
    pendingInterim = null;
    onInterim(text);
  }

  function dropPendingInterim() {
    pendingInterim = null;
    if (interimFlush) { clearTimeout(interimFlush); interimFlush = null; }
  }

  function cancelRetry() {
    waitingForRetry = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function safeStart() {
    try {
      recognition.start();
    } catch {
      // Already started
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognition.onresult = (event: any) => {
    retryDelay = 1000; // a real result: recognition is healthy again
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        dropPendingInterim(); // a final supersedes any interim still waiting to flush
        if (text) onTranscript(text);
      } else {
        interim += result[0].transcript;
      }
    }
    interim = interim.trim();
    if (!interim) return;
    const wait = INTERIM_THROTTLE_MS - (Date.now() - lastInterimAt);
    if (wait <= 0) {
      if (interimFlush) { clearTimeout(interimFlush); interimFlush = null; }
      emitInterim(interim);
    } else {
      // Throttled: keep the newest text and flush it when the window closes, so
      // the LAST interim of an utterance — the one that triggers barge-in — is
      // never dropped.
      pendingInterim = interim;
      if (!interimFlush) {
        interimFlush = setTimeout(() => {
          interimFlush = null;
          if (pendingInterim) emitInterim(pendingInterim);
        }, wait);
      }
    }
  };

  recognition.onend = () => {
    if (shouldListen && !paused && !waitingForRetry) safeStart();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognition.onerror = (event: any) => {
    if (event.error === "not-allowed") {
      // A transient denial must not silence JARVIS until reload: retry with backoff.
      onError("Microphone blocked — retrying. Check this origin's mic permission.");
      waitingForRetry = true;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        waitingForRetry = false;
        if (shouldListen && !paused) safeStart();
      }, delay);
    } else if (event.error === "no-speech" || event.error === "aborted") {
      // Normal: restarts via onend
    } else if (event.error === "audio-capture") {
      // Another process has taken the input device. Chrome keeps the session
      // open and simply stops hearing anything, so without saying so JARVIS
      // looks broken while the real cause is a meeting recorder or a call app
      // holding the mic. Observed live: whole sentences arriving as one word.
      onError("Another app has taken the microphone — quit it, then reload.");
    } else if (event.error === "network") {
      // Web Speech is a Google cloud service, not local recognition: a blip
      // truncates an utterance mid-sentence and nothing reaches the server.
      onError("Speech recognition lost its connection — that sentence was dropped.");
    } else {
      // Anything else is still worth seeing rather than burying in the console.
      onError(`Speech recognition error: ${event.error}`);
    }
    console.warn("[voice] recognition error:", event.error);
  };

  return {
    start() {
      shouldListen = true;
      paused = false;
      cancelRetry();
      safeStart();
    },
    stop() {
      shouldListen = false;
      paused = false;
      cancelRetry();
      dropPendingInterim();
      recognition.stop();
    },
    pause() {
      paused = true;
      dropPendingInterim();
      recognition.stop();
    },
    resume() {
      paused = false;
      // Do not cancel a pending retry: the server's status frames call resume()
      // constantly, and that would turn the backoff into a hammer.
      if (shouldListen && !waitingForRetry) safeStart();
    },
  };
}

// ---------------------------------------------------------------------------
// Audio Player — ordered chunks with acknowledgements
// ---------------------------------------------------------------------------

export interface AudioPlayer {
  enqueue(base64: string, utt: number, idx: number): Promise<void>;
  onNeedsGesture(cb: () => void): void;
  stop(): void;
  dropQueued(): void;
  getAnalyser(): AnalyserNode;
  onPlayed(cb: (utt: number, idx: number) => void): void;
  onFinished(cb: () => void): void;
}

interface QueuedChunk {
  utt: number;
  idx: number;
  buffer: AudioBuffer | null; // null until decoded
  failed: boolean;
}

export function createAudioPlayer(): AudioPlayer {
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  analyser.connect(audioCtx.destination);

  const queue: QueuedChunk[] = [];
  let isPlaying = false;
  let currentSource: AudioBufferSourceNode | null = null;
  let playedCallback: ((utt: number, idx: number) => void) | null = null;
  let finishedCallback: (() => void) | null = null;
  let needsGestureCallback: (() => void) | null = null;
  let gestureNoticeShown = false;

  async function ensureRunning(): Promise<void> {
    if (audioCtx.state === "running") return;
    // resume() never rejects without a user gesture in Chrome — it just stays
    // pending. Wait a moment, then tell the user, then keep waiting: the
    // promise resolves on their first click and playback continues from here.
    const resumed = audioCtx.resume();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
    await Promise.race([resumed, timeout]);
    const state: string = audioCtx.state; // TS narrows the early return away; re-read it
    if (state !== "running") {
      if (!gestureNoticeShown) {
        gestureNoticeShown = true;
        needsGestureCallback?.();
      }
      await resumed;
    }
  }

  function playNext() {
    // Skip chunks that failed to decode, but still acknowledge them so the
    // server's ordering advances.
    while (queue.length > 0 && queue[0].failed) {
      const dead = queue.shift()!;
      playedCallback?.(dead.utt, dead.idx);
    }
    if (queue.length === 0) {
      isPlaying = false;
      currentSource = null;
      finishedCallback?.();
      return;
    }
    const head = queue[0];
    if (!head.buffer) {
      // Not decoded yet: enqueue() will call playNext() when it is.
      isPlaying = false;
      currentSource = null;
      return;
    }
    queue.shift();
    isPlaying = true;
    const source = audioCtx.createBufferSource();
    source.buffer = head.buffer;
    source.connect(analyser);
    currentSource = source;
    source.onended = () => {
      if (currentSource === source) {
        currentSource = null;
        playedCallback?.(head.utt, head.idx);
        playNext();
      }
    };
    source.start();
  }

  return {
    async enqueue(base64: string, utt: number, idx: number) {
      // Reserve the slot BEFORE any await, so order is preserved even if a later
      // chunk's decode (or the context resume) completes first.
      const item: QueuedChunk = { utt, idx, buffer: null, failed: false };
      queue.push(item);
      try {
        await ensureRunning();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        item.buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
      } catch (err) {
        console.error("[audio] chunk unplayable:", err);
        item.failed = true; // still acked in order, so the server's sequence advances
      }
      if (!isPlaying) playNext();
    },

    stop() {
      queue.length = 0;
      if (currentSource) {
        const src = currentSource;
        currentSource = null; // so onended does not ack or chain
        try {
          src.stop();
        } catch {
          // Already stopped
        }
      }
      isPlaying = false;
    },

    dropQueued() {
      // The server keeps exactly one chunk alive: the one playing, or — if
      // nothing has started yet — the head it is still expecting an ack for.
      queue.length = currentSource ? 0 : Math.min(queue.length, 1);
    },

    getAnalyser() {
      return analyser;
    },

    onPlayed(cb) {
      playedCallback = cb;
    },

    onFinished(cb) {
      finishedCallback = cb;
    },

    onNeedsGesture(cb) {
      needsGestureCallback = cb;
    },
  };
}
