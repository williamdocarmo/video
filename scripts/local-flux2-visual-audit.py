#!/usr/bin/env python3

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np


def run_tesseract_tokens(image_path: str):
    command = ["tesseract", image_path, "stdout", "--psm", "11", "-l", "eng", "tsv"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1):
      raise RuntimeError((result.stderr or result.stdout or "tesseract failed").strip())

    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) <= 1:
      return []

    header = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
      values = line.split("\t")
      if len(values) < len(header):
        values.extend([""] * (len(header) - len(values)))
      rows.append(dict(zip(header, values)))

    tokens = []
    for row in rows:
      text = (row.get("text") or "").strip()
      if not text:
        continue
      try:
        confidence = float(row.get("conf") or -1)
      except ValueError:
        confidence = -1
      normalized = re.sub(r"[^A-Za-z0-9]", "", text)
      if (
          (confidence >= 75 and len(normalized) >= 3) or
          (confidence >= 60 and len(normalized) >= 4)
      ):
        tokens.append({"text": text, "confidence": confidence})
    return tokens


def detect_head_metrics(image: np.ndarray):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 70, 160)
    blurred = cv2.medianBlur(gray, 5)
    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(30, gray.shape[0] // 6),
        param1=120,
        param2=24,
        minRadius=max(14, min(gray.shape[:2]) // 24),
        maxRadius=max(45, min(gray.shape[:2]) // 4),
    )

    if circles is None:
      return None

    height, width = gray.shape
    best = None
    for raw in circles[0]:
      x, y, r = [int(v) for v in raw]
      if y > int(height * 0.70):
        continue
      if x - r < 0 or y - r < 0 or x + r >= width or y + r >= height:
        continue

      mask = np.zeros_like(gray, dtype=np.uint8)
      cv2.circle(mask, (x, y), max(8, int(r * 0.66)), 255, -1)
      interior = gray[mask == 255]
      if interior.size == 0:
        continue

      brightness = float(np.mean(interior))
      dark_fraction = float(np.mean(interior < 150))
      edge_fraction = float(np.mean(edges[mask == 255] > 0))
      vertical_penalty = max(0.0, y - (height * 0.55)) * 1.6
      score = (r * 3.0) + brightness - (dark_fraction * 600.0) - (edge_fraction * 200.0) - vertical_penalty

      candidate = {
          "x": x,
          "y": y,
          "r": r,
          "brightness": brightness,
          "dark_fraction": dark_fraction,
          "edge_fraction": edge_fraction,
          "score": score,
      }
      if best is None or candidate["score"] > best["score"]:
        best = candidate

    return best


def detect_window_controls(image: np.ndarray):
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright_mask = cv2.inRange(gray, 200, 255)
    contours, _ = cv2.findContours(bright_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    findings = []
    for contour in contours:
      x, y, w, h = cv2.boundingRect(contour)
      area = w * h
      if area < image.shape[0] * image.shape[1] * 0.08:
        continue
      if w < 120 or h < 120:
        continue
      if w < int(h * 0.9):
        continue
      if x <= 1 or y <= 1 or x + w >= image.shape[1] - 1 or y + h >= image.shape[0] - 1:
        continue

      top_band_h = max(18, int(h * 0.14))
      top_left_w = max(36, int(w * 0.20))
      top_left = rgb[y:y + top_band_h, x:x + top_left_w]
      if top_left.size == 0:
        continue

      circles = cv2.HoughCircles(
          cv2.medianBlur(cv2.cvtColor(top_left, cv2.COLOR_RGB2GRAY), 5),
          cv2.HOUGH_GRADIENT,
          dp=1.2,
          minDist=8,
          param1=70,
          param2=8,
          minRadius=2,
          maxRadius=10,
      )

      filtered_circles = []
      if circles is not None:
        for raw in circles[0]:
          cx, cy, r = raw
          if cx <= top_left_w * 0.55 and cy <= top_band_h * 0.65 and 2 <= r <= 10:
            filtered_circles.append((cx, cy, r))

      circle_count = len(filtered_circles)
      if circle_count >= 2:
        findings.append({
            "rect": [int(x), int(y), int(w), int(h)],
            "circle_count": int(circle_count),
        })

    return findings


def compute_sharpness_metrics(image: np.ndarray):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    laplacian_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    contrast_std = float(np.std(gray))
    return {
        "laplacian_variance": laplacian_variance,
        "contrast_std": contrast_std,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--expect-stickman", action="store_true")
    parser.add_argument("--allow-head-accessories", action="store_true")
    args = parser.parse_args()

    image_path = Path(args.image)
    image = cv2.imread(str(image_path))
    if image is None:
      raise SystemExit(json.dumps({
          "passed": False,
          "reasons": [f"nao consegui abrir a imagem: {image_path}"],
      }))

    reasons = []
    file_size_bytes = int(image_path.stat().st_size)
    ocr_tokens = []
    try:
      ocr_tokens = run_tesseract_tokens(str(image_path))
    except Exception as exc:
      reasons.append(f"ocr local falhou: {exc}")

    if ocr_tokens:
      reasons.append(f"ocr detectou texto provavel: {', '.join(token['text'] for token in ocr_tokens[:5])}")

    head = detect_head_metrics(image)
    if args.expect_stickman and head is None:
      reasons.append(
          "cabeca do stickman nao ficou clara o suficiente ou o personagem principal ficou pequeno demais"
      )

    if args.expect_stickman and head:
      dark_fraction = float(head["dark_fraction"])
      edge_fraction = float(head["edge_fraction"])
      head_radius_ratio = float(head["r"]) / max(1.0, float(min(image.shape[0], image.shape[1])))
      # Relaxed thresholds: stick figure style intentionally has minimal
      # facial marks (dot eyes, line mouth) which should NOT be rejected.
      if args.allow_head_accessories:
        has_dense_internal_marks = (
            dark_fraction > 0.45 or
            edge_fraction > 0.25 or
            (dark_fraction > 0.30 and edge_fraction > 0.15)
        )
      else:
        has_dense_internal_marks = (
            dark_fraction > 0.38 or
            edge_fraction > 0.18 or
            (dark_fraction > 0.22 and edge_fraction > 0.10)
        )

      if has_dense_internal_marks:
        reasons.append(
            "cabeca do stickman parece ter tracos faciais excessivos ou detalhes realistas "
            f"(dark_fraction={dark_fraction:.4f}, edge_fraction={edge_fraction:.4f})"
        )

      if head_radius_ratio > 0.17:
        reasons.append(
            "cabeca do stickman ocupa area demais e parece enquadramento com zoom/close-up "
            f"(head_radius_ratio={head_radius_ratio:.4f})"
        )

      if head_radius_ratio < 0.038:
        reasons.append(
            "personagem principal parece pequeno demais ou reduzido a um palito no enquadramento "
            f"(head_radius_ratio={head_radius_ratio:.4f})"
        )

    window_controls = detect_window_controls(image)
    if window_controls:
      reasons.append("imagem parece conter window controls ou chrome de navegador")

    sharpness = compute_sharpness_metrics(image)
    if (
        sharpness["laplacian_variance"] < 180.0 and
        file_size_bytes > 1_500_000
    ):
      reasons.append(
          "imagem parece borrada ou texturizada demais para o estilo flat "
          f"(laplacian_variance={sharpness['laplacian_variance']:.2f}, bytes={file_size_bytes})"
      )

    payload = {
        "passed": len(reasons) == 0,
        "file_size_bytes": file_size_bytes,
        "ocr_tokens": ocr_tokens,
        "head": head,
        "sharpness": sharpness,
        "window_controls": window_controls,
        "reasons": reasons,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
