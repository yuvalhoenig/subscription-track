/**
 * Voice input.
 *
 * Prefers on-device recognition (the Web Speech API in the browser,
 * macOS speech recognition when running inside Electron): the audio never
 * leaves the machine, there is no per-request cost, and results stream in
 * as the user speaks. Falls back to recording a clip and posting it to the
 * server only when the platform offers no local recogniser and the server
 * is configured for transcription.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { api } from '../lib/api.js';

const SpeechRecognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition ?? window.webkitSpeechRecognition
    : null;

/** True when something on this platform can transcribe locally. */
export function hasLocalSpeech() {
  return Boolean(SpeechRecognition) || Boolean(window.subtrack?.speech?.available);
}

export function VoiceInput({ onTranscript, onError, language = 'en-US', disabled }) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);

  useEffect(() => {
    // Server-side transcription is the last resort; if none of the three
    // paths exist, hide the button rather than offering a dead control.
    setSupported(hasLocalSpeech() || typeof MediaRecorder !== 'undefined');
    return () => {
      recognitionRef.current?.abort?.();
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    };
  }, []);

  /** Electron: hand off to the native macOS recogniser over the bridge. */
  const startNative = useCallback(async () => {
    setRecording(true);
    try {
      const text = await window.subtrack.speech.listen({ language });
      if (text) onTranscript(text, { final: true });
    } catch (error) {
      onError?.(error.message ?? 'Speech recognition failed');
    } finally {
      setRecording(false);
    }
  }, [language, onTranscript, onError]);

  /** Browser: Web Speech API, streaming interim results. */
  const startWebSpeech = useCallback(() => {
    const recognition = new SpeechRecognition();
    recognition.lang = language;
    // Interim results let the input fill in as the user speaks, which
    // makes the feature feel responsive rather than laggy.
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let text = '';
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
        if (event.results[i].isFinal) isFinal = true;
      }
      onTranscript(text.trim(), { final: isFinal });
    };
    recognition.onerror = (event) => {
      setRecording(false);
      // 'aborted' and 'no-speech' are normal outcomes, not failures.
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      onError?.(
        event.error === 'not-allowed'
          ? 'Microphone access was denied. Allow it in your browser settings.'
          : `Speech recognition failed (${event.error})`,
      );
    };
    recognition.onend = () => setRecording(false);

    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  }, [language, onTranscript, onError]);

  /** No local recogniser: record a clip and let the server transcribe. */
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        // Always release the microphone, whatever happens next.
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1200) return; // too short to contain speech
        try {
          const { text } = await api.ai.transcribe(blob);
          if (text) onTranscript(text, { final: true });
        } catch (error) {
          onError?.(
            error.status === 400
              ? 'This server expects on-device transcription, which this browser does not support.'
              : error.message,
          );
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecording(false);
      onError?.('Could not access the microphone.');
    }
  }, [onTranscript, onError]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop?.();
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    setRecording(false);
  }, []);

  const toggle = useCallback(() => {
    if (recording) {
      stop();
      return;
    }
    if (window.subtrack?.speech?.available) startNative();
    else if (SpeechRecognition) startWebSpeech();
    else startRecording();
  }, [recording, stop, startNative, startWebSpeech, startRecording]);

  if (!supported) return null;

  return (
    <button
      type="button"
      className="mic"
      data-recording={recording ? 'true' : 'false'}
      onClick={toggle}
      disabled={disabled}
      title={recording ? 'Stop listening' : 'Speak instead of typing'}
      aria-label={recording ? 'Stop listening' : 'Start voice input'}
      aria-pressed={recording}
    >
      <Icon name="mic" size={17} />
    </button>
  );
}

export default VoiceInput;
