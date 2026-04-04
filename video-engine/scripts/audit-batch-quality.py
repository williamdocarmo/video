#!/usr/bin/env python3

import argparse
import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import cv2
import numpy as np


def normalize(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    normalized = re.sub(r"\.mp4$", "", normalized)
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized).strip()
    return normalized


def match_title_to_video(title: str, videos: list[Path]) -> tuple[Path | None, float]:
    title_norm = normalize(title)
    title_tokens = set(title_norm.split())
    best_path = None
    best_score = -1.0

    for video_path in videos:
        video_norm = normalize(video_path.name)
        video_tokens = set(video_norm.split())
        intersection = len(title_tokens & video_tokens)
        union = len(title_tokens | video_tokens) or 1
        jaccard = intersection / union
        sequence = SequenceMatcher(None, title_norm, video_norm).ratio()
        score = jaccard * 0.7 + sequence * 0.3

        if score > best_score:
            best_score = score
            best_path = video_path

    return best_path, best_score


def analyze_video(video_path: Path) -> dict:
    capture = cv2.VideoCapture(str(video_path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
    duration = frames / fps if fps else 0.0

    samples = []
    sample_step = max(8.0, min(12.0, duration / 10.0 if duration else 8.0))
    current_time = 5.0

    while current_time < duration - 3.0 and len(samples) < 14:
        capture.set(cv2.CAP_PROP_POS_MSEC, current_time * 1000.0)
        ok, frame = capture.read()
        if not ok:
            current_time += sample_step
            continue

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 80, 160)
        edge_ratio = float((edges > 0).mean())
        small = cv2.resize(gray, (64, 64))
        sobel_x = cv2.Sobel(small, cv2.CV_64F, 1, 0, ksize=3)
        sobel_y = cv2.Sobel(small, cv2.CV_64F, 0, 1, ksize=3)
        grad = float((np.abs(sobel_x) + np.abs(sobel_y)).mean())
        flat = grad < 50.0 and edge_ratio < 0.006

        samples.append(
            {
                "t": round(current_time, 1),
                "grad": round(grad, 2),
                "edge_ratio": round(edge_ratio, 5),
                "flat": flat,
            }
        )
        current_time += sample_step

    capture.release()

    later_samples = samples[1:] if len(samples) > 1 else samples
    flat_count = sum(1 for sample in later_samples if sample["flat"])
    flat_ratio = flat_count / len(later_samples) if later_samples else 0.0

    return {
        "duration": round(duration, 2),
        "samples": samples,
        "sample_count_after_intro": len(later_samples),
        "flat_after_intro_count": flat_count,
        "flat_ratio_after_intro": round(flat_ratio, 3),
        "intro_flat": bool(samples and samples[0]["flat"]),
        "severe": flat_ratio >= 0.8,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-file", required=True)
    parser.add_argument("--video-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    batch_file = Path(args.batch_file)
    video_dir = Path(args.video_dir)
    output_path = Path(args.output)

    titles = [line.strip() for line in batch_file.read_text().splitlines() if line.strip()]
    videos = sorted(video_dir.glob("*.mp4"))
    results = []
    missing = []

    for title in titles:
        matched_path, score = match_title_to_video(title, videos)
        if matched_path is None or score < 0.45:
            missing.append({"title": title, "score": round(score, 3), "match": str(matched_path) if matched_path else None})
            continue

        results.append(
            {
                "title": title,
                "file": str(matched_path),
                "matchScore": round(score, 3),
                **analyze_video(matched_path),
            }
        )

    severe_results = sorted(
        [item for item in results if item["severe"]],
        key=lambda item: (-item["flat_ratio_after_intro"], item["title"]),
    )

    summary = {
        "total_titles": len(titles),
        "matched": len(results),
        "missing": missing,
        "severe_count": len(severe_results),
        "good_count": sum(1 for item in results if item["flat_ratio_after_intro"] < 0.2),
        "severe_titles": [
            {
                "title": item["title"],
                "file": Path(item["file"]).name,
                "flat_ratio_after_intro": item["flat_ratio_after_intro"],
                "intro_flat": item["intro_flat"],
            }
            for item in severe_results
        ],
    }

    payload = {
        "summary": summary,
        "results": results,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
