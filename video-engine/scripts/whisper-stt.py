#!/usr/bin/env python3
"""Word-level timestamps via mlx-whisper. Usage: whisper-stt.py <mp3> <language> <output.json>"""
import sys, json, mlx_whisper

mp3, lang, out = sys.argv[1], sys.argv[2], sys.argv[3]

language = (lang or "pt").strip().replace("_", "-").split("-")[0].lower()
result = mlx_whisper.transcribe(mp3, word_timestamps=True, language=language)

def has_word_characters(token):
    return any(ch.isalnum() for ch in token)

def clean_word(token):
    return " ".join(str(token).split()).strip()

words = []
last_end = 0.0
for seg in result.get("segments", []):
    for w in seg.get("words", []):
        text = clean_word(w.get("word", ""))
        if not text or not has_word_characters(text):
            continue

        try:
            start = float(w.get("start"))
            end = float(w.get("end"))
        except (TypeError, ValueError):
            continue

        if end < start:
            start, end = end, start

        if start < last_end:
            start = last_end

        if end <= start:
            end = start + 0.04

        start = round(start, 3)
        end = round(max(end, start + 0.04), 3)
        last_end = end
        words.append({"text": text, "start": start, "end": end})

with open(out, "w") as f:
    json.dump(words, f, ensure_ascii=False)
print(f"{len(words)} words")
