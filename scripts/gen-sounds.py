#!/usr/bin/env python3
# Regenerate the two notification sounds in src-tauri/resources/sounds.
#
#   python3 scripts/gen-sounds.py      (needs `lame` on PATH)
#
# They are synthesized here rather than downloaded, so the repo holds no
# audio whose licence forbids passing the file on. Change a note or a decay
# below and rerun; the script is the source, the MP3s are its output.

import math
import os
import struct
import subprocess
import tempfile
import wave

RATE = 48000
OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "resources", "sounds")

# (multiple of the fundamental, level): a soft bell, mostly fundamental.
PARTIALS = [(1.0, 1.0), (2.0, 0.35), (3.0, 0.12), (4.2, 0.05)]


# A note is (frequency, start, decay, level). It is struck with a 6 ms attack,
# and each partial dies faster than the one below it.
def render(notes, length):
    samples = [0.0] * int(RATE * length)
    for freq, start, decay, level in notes:
        first = int(RATE * start)
        for i in range(first, len(samples)):
            t = (i - first) / RATE
            attack = min(1.0, t / 0.006)
            value = 0.0
            for multiple, amount in PARTIALS:
                value += amount * math.exp(-t * multiple / decay) * math.sin(2 * math.pi * freq * multiple * t)
            samples[i] += level * attack * value
    peak = max(abs(s) for s in samples)
    fade = int(RATE * 0.05)
    for i in range(fade):
        samples[-1 - i] *= i / fade
    return [s / peak * 0.5 for s in samples]


def write(name, samples):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = tmp.name
    with wave.open(path, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(b"".join(struct.pack("<hh", int(s * 32767), int(s * 32767)) for s in samples))
    subprocess.run(["lame", "--quiet", "-V", "2", path, os.path.join(OUT, name)], check=True)
    os.remove(path)


E5, A5 = 659.25, 880.00
C5, G5, E6 = 523.25, 783.99, 1318.51

# Needs you: two taps a fourth apart, rising, the shape of a question.
write("needs-you.mp3", render([(E5, 0.0, 0.22, 0.9), (A5, 0.16, 0.30, 1.0)], 1.3))

# Turn finished: one open chord rolled upward and left to ring, so it settles.
write("turn-finished.mp3", render([(C5, 0.0, 0.45, 0.8), (G5, 0.05, 0.45, 0.6), (E6, 0.10, 0.40, 0.4)], 1.8))
