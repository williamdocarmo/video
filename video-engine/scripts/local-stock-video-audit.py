#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def percentile_frame_indices(frame_count: int):
    if frame_count <= 1:
        return [0]

    indices = {
        0,
        max(0, int(round(frame_count * 0.25)) - 1),
        max(0, int(round(frame_count * 0.50)) - 1),
        max(0, int(round(frame_count * 0.75)) - 1),
        max(0, frame_count - 1),
    }
    return sorted(indices)


def sample_frames(video_path: str):
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        return 0, []

    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    indices = percentile_frame_indices(frame_count)
    frames = []

    for index in indices:
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if ok and frame is not None:
            frames.append({"index": index, "frame": frame})

    capture.release()
    return frame_count, frames


def analyze_frame(frame: np.ndarray):
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    small = cv2.resize(rgb, (64, 36), interpolation=cv2.INTER_AREA)
    quantized = (small.reshape(-1, 3) // 32).astype(np.int16)
    edges = cv2.Canny(gray, 80, 180)

    return {
        "white_fraction": float(np.mean(np.all(rgb >= 235, axis=2))),
        "laplacian_variance": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
        "contrast_std": float(np.std(gray)),
        "edge_density": float(np.mean(edges > 0)),
        "quantized_color_count": int(len(np.unique(quantized, axis=0))),
        "saturation_mean": float(np.mean(hsv[:, :, 1])),
    }


def compute_motion(entries):
    motions = []
    previous = None

    for entry in entries:
        gray = cv2.cvtColor(entry["frame"], cv2.COLOR_BGR2GRAY)
        small = cv2.resize(gray, (64, 36), interpolation=cv2.INTER_AREA)
        if previous is not None:
            motions.append(float(np.mean(cv2.absdiff(previous, small))))
        previous = small

    return motions


def median_metric(metrics, key: str):
    values = [float(metric[key]) for metric in metrics]
    return float(np.median(values)) if values else 0.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    args = parser.parse_args()

    video_path = Path(args.video)
    if not video_path.exists():
      print(json.dumps({
          "passed": False,
          "reasons": [f"nao consegui encontrar o video: {video_path}"],
      }))
      return

    frame_count, entries = sample_frames(str(video_path))
    if not entries:
      print(json.dumps({
          "passed": False,
          "reasons": [f"nao consegui extrair frames de {video_path}"],
      }))
      return

    metrics = [analyze_frame(entry["frame"]) for entry in entries]
    motion_values = compute_motion(entries)

    median_laplacian = median_metric(metrics, "laplacian_variance")
    median_contrast = median_metric(metrics, "contrast_std")
    median_edge_density = median_metric(metrics, "edge_density")
    median_quantized_color_count = median_metric(metrics, "quantized_color_count")
    median_motion = float(np.median(motion_values)) if motion_values else 0.0

    reasons = []

    if (
        median_laplacian < 40.0 and
        median_contrast < 30.0 and
        median_edge_density < 0.012
    ):
        reasons.append(
            "clip parece sem detalhe visual suficiente para cena principal "
            f"(laplacian={median_laplacian:.2f}, contrast={median_contrast:.2f}, edge_density={median_edge_density:.4f})"
        )

    if (
        median_motion < 0.2 and
        median_laplacian < 80.0 and
        median_contrast < 35.0 and
        median_quantized_color_count < 48.0
    ):
        reasons.append(
            "clip parece um quadro quase estatico ou placeholder de baixa fidelidade "
            f"(motion={median_motion:.3f}, colors={median_quantized_color_count:.0f})"
        )

    payload = {
        "passed": len(reasons) == 0,
        "frame_count": frame_count,
        "sampled_frames": [
            {
                "frame_index": int(entry["index"]),
                **{
                    key: (
                        round(value, 6)
                        if isinstance(value, float)
                        else value
                    )
                    for key, value in metric.items()
                }
            }
            for entry, metric in zip(entries, metrics)
        ],
        "median_metrics": {
            "laplacian_variance": round(median_laplacian, 6),
            "contrast_std": round(median_contrast, 6),
            "edge_density": round(median_edge_density, 6),
            "quantized_color_count": round(median_quantized_color_count, 6),
            "motion_mean_absdiff": round(median_motion, 6),
        },
        "motion_values": [round(value, 6) for value in motion_values],
        "file_size_bytes": int(video_path.stat().st_size),
        "reasons": reasons,
    }

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
