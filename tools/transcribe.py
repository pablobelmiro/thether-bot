"""Transcribe one audio file to text with faster-whisper (runs locally, CPU).

Usage: python -I transcribe.py <audio-file> [model] [language]
  model:    tiny | base | small | medium | large-v3   (default: small)
  language: ISO code like "pt" or "auto"              (default: auto)

Prints the transcript on stdout. Exit code 3 = no speech found.
The audio is decoded with ffmpeg (Telegram's Ogg/Opus, mp3, m4a, mp4…) into
16 kHz mono samples, so faster-whisper's own PyAV decoder is never used.
"""

import shutil
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def decode(path: str) -> np.ndarray:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    out = subprocess.run(
        [ffmpeg, "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
        timeout=120,
    ).stdout
    return np.frombuffer(out, dtype=np.float32)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-file> [model] [language]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
    language = sys.argv[3] if len(sys.argv) > 3 else "auto"

    audio = decode(path)
    if audio.size == 0:
        return 3
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        audio,
        language=None if language == "auto" else language,
        vad_filter=True,  # skip silence
        beam_size=5,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    if not text:
        return 3
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
