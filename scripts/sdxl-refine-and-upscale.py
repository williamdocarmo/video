#!/usr/bin/env -S python3
"""
sdxl-refine-and-upscale.py

Pipeline: FLUX2 image -> SDXL img2img refinement -> Lanczos upscale + sharpening

Single mode:
  python3 scripts/sdxl-refine-and-upscale.py \
    --input scene-01.png --output scene-01-refined.png --prompt "..."

Batch mode (loads model once, processes many images):
  python3 scripts/sdxl-refine-and-upscale.py --batch jobs.json

  jobs.json = [{"input": "...", "output": "...", "prompt": "...", "seed": 42}, ...]
"""

import argparse
import json
import sys
import time
import os
import warnings


def parse_args():
    p = argparse.ArgumentParser(description="SDXL refine + upscale for FLUX2 images")
    p.add_argument("--input", help="Input PNG from FLUX2 (single mode)")
    p.add_argument("--output", help="Output refined PNG (single mode)")
    p.add_argument("--prompt", default="", help="Positive prompt")
    p.add_argument("--negative-prompt", default="text, watermark, logo, blurry, low quality, deformed")
    p.add_argument("--denoise", type=float, default=0.3)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--sdxl-model", default="stabilityai/stable-diffusion-xl-refiner-1.0")
    p.add_argument("--upscale-factor", type=int, default=2)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--skip-sdxl", action="store_true")
    p.add_argument("--skip-upscale", action="store_true")
    p.add_argument("--max-dimension", type=int, default=1024)
    p.add_argument("--guidance-scale", type=float, default=7.5)
    p.add_argument("--batch", help="Path to JSON file with batch jobs")
    p.add_argument("--ssim-threshold", type=float, default=0.4,
                   help="Min SSIM between original and refined (rejects if SDXL corrupted the image)")
    p.add_argument("--upscale-method", choices=["auto", "realesrgan", "lanczos"], default="auto",
                   help="Upscale method: auto tries Real-ESRGAN first, falls back to Lanczos")
    p.add_argument("--realesrgan-model", default="RealESRGAN_x2plus",
                   help="Real-ESRGAN model name (RealESRGAN_x2plus, RealESRGAN_x4plus, RealESRNet_x4plus)")
    p.add_argument("--skip-clahe", action="store_true", help="Skip CLAHE contrast enhancement")
    p.add_argument("--prompt-word-limit", type=int, default=36,
                   help="Trim positive prompts to this many words before SDXL tokenization")
    return p.parse_args()


def normalize_whitespace(text):
    return " ".join(str(text or "").split())


def compact_prompt(prompt, max_words):
    cleaned = normalize_whitespace(prompt)
    if not cleaned:
        return ""

    words = cleaned.split(" ")
    if len(words) <= max_words:
        return cleaned

    return " ".join(words[:max_words]).strip()


def load_and_prepare_image(input_path, max_dim):
    """Load image and resize for SDXL (must be multiple of 8)."""
    from PIL import Image
    img = Image.open(input_path).convert("RGB")
    w, h = img.size

    if max(w, h) > max_dim:
        ratio = max_dim / max(w, h)
        w = int(w * ratio)
        h = int(h * ratio)

    w = (w // 8) * 8
    h = (h // 8) * 8

    if (w, h) != img.size:
        img = img.resize((w, h), Image.LANCZOS)

    return img, img.size


def load_sdxl_pipeline(model_id):
    """Load SDXL pipeline with float16 for MPS (Apple Silicon)."""
    import torch
    from diffusers import StableDiffusionXLImg2ImgPipeline

    warnings.filterwarnings(
        "ignore",
        message=r".*upcast_vae.*deprecated.*",
        category=FutureWarning,
    )

    sys.stderr.write(f"[sdxl] loading model: {model_id}\n")
    t0 = time.time()

    # float16 is 2-4x faster on MPS and uses half the memory (~13GB vs ~26GB)
    dtype = torch.float16

    try:
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            use_safetensors=True,
            variant="fp16",
        )
    except OSError:
        sys.stderr.write("[sdxl] fp16 variant not found, loading default weights as float16\n")
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            use_safetensors=True,
        )

    pipe = pipe.to("mps")

    # VAE must run in float32 to avoid NaN/black pixels (known SDXL fp16 issue)
    pipe.vae = pipe.vae.to(dtype=torch.float32)

    # NOTE: enable_attention_slicing() and enable_vae_slicing() are intentionally
    # NOT used — they cause NaN in VAE decode on MPS with mixed fp16/fp32 dtypes
    # (diffusers 0.36+). The memory savings are negligible on Apple Silicon unified memory.

    sys.stderr.write(f"[sdxl] model loaded in {time.time() - t0:.1f}s\n")
    return pipe


def refine_with_sdxl(pipe, img, prompt, negative_prompt, denoise, steps, guidance_scale, seed=None):
    """Run SDXL img2img refinement."""
    import torch

    generator = None
    if seed is not None:
        generator = torch.Generator("mps").manual_seed(seed)

    sys.stderr.write(
        f"[sdxl] refining: denoise={denoise} steps={steps} "
        f"guidance={guidance_scale} size={img.size}\n"
    )
    t0 = time.time()

    result = pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=img,
        strength=denoise,
        num_inference_steps=steps,
        guidance_scale=guidance_scale,
        generator=generator,
    ).images[0]

    sys.stderr.write(f"[sdxl] refinement done in {time.time() - t0:.1f}s\n")
    return result


def compute_ssim(img_a, img_b):
    """Compute structural similarity between two PIL images (0..1)."""
    import numpy as np

    a = np.array(img_a.convert("L"), dtype=np.float64)
    b = np.array(img_b.convert("L"), dtype=np.float64)

    if a.shape != b.shape:
        from PIL import Image
        img_b_resized = img_b.resize(img_a.size, Image.LANCZOS)
        b = np.array(img_b_resized.convert("L"), dtype=np.float64)

    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2

    mu_a = a.mean()
    mu_b = b.mean()
    sigma_a_sq = a.var()
    sigma_b_sq = b.var()
    sigma_ab = ((a - mu_a) * (b - mu_b)).mean()

    num = (2 * mu_a * mu_b + c1) * (2 * sigma_ab + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (sigma_a_sq + sigma_b_sq + c2)

    return float(num / den)


def check_color_drift(img_original, img_refined, max_drift=40.0):
    """Check if SDXL refinement caused excessive color shift.
    Returns (drift_value, passed)."""
    import numpy as np

    orig_arr = np.array(img_original, dtype=np.float64)
    ref_arr = np.array(img_refined, dtype=np.float64)

    if orig_arr.shape != ref_arr.shape:
        from PIL import Image
        img_refined_resized = img_refined.resize(img_original.size, Image.LANCZOS)
        ref_arr = np.array(img_refined_resized, dtype=np.float64)

    orig_means = orig_arr.mean(axis=(0, 1))
    ref_means = ref_arr.mean(axis=(0, 1))

    drift = float(np.sqrt(((orig_means - ref_means) ** 2).sum()))
    return drift, drift <= max_drift


ESRGAN_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".esrgan-models")
ESRGAN_MODEL_URLS = {
    "RealESRGAN_x2plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    "RealESRGAN_x4plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    "RealESRNet_x4plus": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth",
}


def _download_model(model_name):
    """Download model weights if not cached. Returns local path."""
    import urllib.request

    os.makedirs(ESRGAN_MODELS_DIR, exist_ok=True)
    local_path = os.path.join(ESRGAN_MODELS_DIR, f"{model_name}.pth")

    if os.path.isfile(local_path):
        return local_path

    url = ESRGAN_MODEL_URLS.get(model_name)
    if not url:
        return None

    sys.stderr.write(f"[realesrgan] downloading {model_name}...\n")
    urllib.request.urlretrieve(url, local_path)
    sys.stderr.write(f"[realesrgan] saved to {local_path}\n")
    return local_path


def _try_load_realesrgan(model_name):
    """Try to load Real-ESRGAN via spandrel. Returns (model, device) or (None, None)."""
    try:
        import torch
        import spandrel

        model_path = _download_model(model_name)
        if not model_path:
            sys.stderr.write(f"[realesrgan] unknown model: {model_name}\n")
            return None, None

        device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

        sys.stderr.write(f"[realesrgan] loading {model_name} via spandrel on {device}...\n")
        t0 = time.time()

        model = spandrel.ModelLoader(device=device).load_from_file(model_path)
        model.eval()

        sys.stderr.write(f"[realesrgan] loaded in {time.time() - t0:.1f}s (scale={model.scale})\n")
        return model, device

    except ImportError as e:
        sys.stderr.write(f"[realesrgan] not available ({e}), will use Lanczos fallback\n")
        return None, None
    except Exception as e:
        sys.stderr.write(f"[realesrgan] failed to load ({e}), will use Lanczos fallback\n")
        return None, None


def _tile_inference(model, img_tensor, device, tile_size=512, tile_pad=10):
    """Run model inference with tiling to avoid OOM on large images."""
    import torch

    _, _, h, w = img_tensor.shape

    if h <= tile_size and w <= tile_size:
        with torch.no_grad():
            return model(img_tensor)

    scale = model.scale
    out_h, out_w = h * scale, w * scale
    output = torch.zeros((1, 3, out_h, out_w), device=device)

    tiles_y = (h + tile_size - 1) // tile_size
    tiles_x = (w + tile_size - 1) // tile_size

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            y0 = ty * tile_size
            x0 = tx * tile_size
            y1 = min(y0 + tile_size, h)
            x1 = min(x0 + tile_size, w)

            # Add padding
            py0 = max(y0 - tile_pad, 0)
            px0 = max(x0 - tile_pad, 0)
            py1 = min(y1 + tile_pad, h)
            px1 = min(x1 + tile_pad, w)

            tile = img_tensor[:, :, py0:py1, px0:px1]
            with torch.no_grad():
                tile_out = model(tile)

            # Calculate output region (without padding)
            oy0 = (y0 - py0) * scale
            ox0 = (x0 - px0) * scale
            oy1 = oy0 + (y1 - y0) * scale
            ox1 = ox0 + (x1 - x0) * scale

            output[:, :, y0 * scale:y1 * scale, x0 * scale:x1 * scale] = tile_out[:, :, oy0:oy1, ox0:ox1]

    return output


def upscale_with_realesrgan(img, model, device):
    """Upscale using Real-ESRGAN via spandrel. Returns (PIL Image, True) or (None, False)."""
    try:
        import torch
        import numpy as np
        from PIL import Image

        img_np = np.array(img).astype(np.float32) / 255.0
        # HWC -> NCHW
        img_tensor = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0).to(device)

        t0 = time.time()
        output_tensor = _tile_inference(model, img_tensor, device, tile_size=512)
        elapsed = time.time() - t0

        # NCHW -> HWC
        output_np = output_tensor.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy()
        output_np = (output_np * 255).round().astype(np.uint8)
        result = Image.fromarray(output_np)

        sys.stderr.write(
            f"[realesrgan] {img.size[0]}x{img.size[1]} -> {result.size[0]}x{result.size[1]} "
            f"in {elapsed:.1f}s\n"
        )
        return result, True

    except Exception as e:
        sys.stderr.write(f"[realesrgan] enhance failed: {e}\n")
        return None, False


def upscale_with_lanczos(img, factor):
    """Lanczos upscale + adaptive unsharp mask sharpening."""
    from PIL import Image, ImageFilter, ImageStat

    w, h = img.size
    new_w, new_h = w * factor, h * factor

    sys.stderr.write(f"[upscale] {w}x{h} -> {new_w}x{new_h} (Lanczos + adaptive sharpen)\n")

    img = img.resize((new_w, new_h), Image.LANCZOS)

    gray = img.convert("L")
    stat = ImageStat.Stat(gray)
    stddev = stat.stddev[0]

    if stddev > 60:
        radius, percent, threshold = 1.5, 100, 4
    elif stddev > 35:
        radius, percent, threshold = 2, 150, 3
    else:
        radius, percent, threshold = 2.5, 180, 2

    sys.stderr.write(f"[upscale] adaptive sharpen: stddev={stddev:.1f} radius={radius} percent={percent} threshold={threshold}\n")
    img = img.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))

    return img


def upscale_image(img, factor, method="auto", realesrgan_model="RealESRGAN_x2plus"):
    """Upscale image using Real-ESRGAN (preferred) or Lanczos (fallback)."""
    if factor <= 1:
        return img, "skipped"

    if method in ("auto", "realesrgan"):
        model, device = _try_load_realesrgan(realesrgan_model)
        if model is not None:
            result, ok = upscale_with_realesrgan(img, model, device)
            if ok and result is not None:
                # If model scale doesn't match desired factor, resize to exact target
                target_w, target_h = img.size[0] * factor, img.size[1] * factor
                if result.size != (target_w, target_h):
                    from PIL import Image
                    result = result.resize((target_w, target_h), Image.LANCZOS)

                # Cleanup GPU memory
                del model
                try:
                    import torch
                    if hasattr(torch, "mps"):
                        torch.mps.empty_cache()
                except Exception:
                    pass

                return result, "realesrgan"

            if method == "realesrgan":
                sys.stderr.write("[upscale] Real-ESRGAN failed and was explicitly requested, falling back to Lanczos\n")

    img = upscale_with_lanczos(img, factor)
    return img, "lanczos"


def apply_clahe(img):
    """Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) for better contrast."""
    import numpy as np
    import cv2
    from PIL import Image

    img_np = np.array(img)

    # Convert to LAB color space (only enhance L channel, preserve colors)
    lab = cv2.cvtColor(img_np, cv2.COLOR_RGB2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)

    # CLAHE on lightness channel only
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_channel)

    lab_enhanced = cv2.merge([l_enhanced, a_channel, b_channel])
    result_np = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2RGB)

    sys.stderr.write("[clahe] contrast enhancement applied (clipLimit=2.0, tile=8x8)\n")
    return Image.fromarray(result_np)


def process_one(args, img_input, img_output, prompt, seed, pipe=None):
    """Process a single image. Returns result dict."""
    from PIL import Image

    if not os.path.isfile(img_input):
        sys.stderr.write(f"[error] input not found: {img_input}\n")
        return {"input": img_input, "error": "file not found"}

    img, original_size = load_and_prepare_image(img_input, args.max_dimension)
    sys.stderr.write(f"[pipeline] input: {os.path.basename(img_input)} ({original_size[0]}x{original_size[1]})\n")

    result_info = {
        "input": img_input,
        "output": img_output,
        "original_size": list(original_size),
        "phases": [],
    }
    compacted_prompt = compact_prompt(prompt, args.prompt_word_limit)
    original_prompt_words = len(normalize_whitespace(prompt).split(" ")) if normalize_whitespace(prompt) else 0
    compacted_prompt_words = len(compacted_prompt.split(" ")) if compacted_prompt else 0

    if compacted_prompt and compacted_prompt != normalize_whitespace(prompt):
        sys.stderr.write(
            f"[sdxl] compact prompt: {original_prompt_words} -> {compacted_prompt_words} words\n"
        )

    result_info["prompt_words"] = {
        "original": original_prompt_words,
        "used": compacted_prompt_words,
    }

    # SDXL refinement with quality validation
    if not args.skip_sdxl and pipe is not None:
        img_before = img.copy()
        try:
            refined = refine_with_sdxl(
                pipe, img, compacted_prompt, args.negative_prompt,
                args.denoise, args.steps, args.guidance_scale, seed
            )

            # SSIM check: ensure SDXL didn't destroy the image
            ssim_val = compute_ssim(img_before, refined)
            sys.stderr.write(f"[sdxl] quality check: SSIM={ssim_val:.4f} (threshold={args.ssim_threshold})\n")

            # Color drift check
            color_drift, color_ok = check_color_drift(img_before, refined)
            sys.stderr.write(f"[sdxl] color drift: {color_drift:.2f} {'OK' if color_ok else 'WARN'}\n")

            phase_info = {
                "name": "sdxl-refine",
                "denoise": args.denoise,
                "steps": args.steps,
                "size": list(refined.size),
                "ssim": round(ssim_val, 4),
                "color_drift": round(color_drift, 2),
            }

            if ssim_val < args.ssim_threshold:
                sys.stderr.write(
                    f"[sdxl] WARN: SSIM {ssim_val:.4f} below threshold {args.ssim_threshold}, "
                    f"using original image\n"
                )
                phase_info["status"] = "rejected-low-ssim"
                result_info["phases"].append(phase_info)
                # Keep original img
            elif not color_ok:
                sys.stderr.write(
                    f"[sdxl] WARN: color drift {color_drift:.2f} too high, using original image\n"
                )
                phase_info["status"] = "rejected-color-drift"
                result_info["phases"].append(phase_info)
                # Keep original img
            else:
                img = refined
                phase_info["status"] = "applied"
                result_info["phases"].append(phase_info)

        except Exception as e:
            sys.stderr.write(f"[sdxl] WARN: refinement failed, using original: {e}\n")
            result_info["phases"].append({"name": "sdxl-refine", "status": "failed", "error": str(e)})
            img = Image.open(img_input).convert("RGB")
    else:
        result_info["phases"].append({"name": "sdxl-refine", "status": "skipped"})

    # Upscale
    if not args.skip_upscale and args.upscale_factor > 1:
        img, upscale_method = upscale_image(
            img, args.upscale_factor,
            method=args.upscale_method,
            realesrgan_model=args.realesrgan_model,
        )
        result_info["phases"].append({
            "name": "upscale",
            "factor": args.upscale_factor,
            "method": upscale_method,
            "final_size": list(img.size),
        })
    else:
        result_info["phases"].append({"name": "upscale", "status": "skipped"})

    # CLAHE contrast enhancement
    if not args.skip_clahe:
        try:
            img = apply_clahe(img)
            result_info["phases"].append({"name": "clahe", "status": "applied"})
        except Exception as e:
            sys.stderr.write(f"[clahe] WARN: skipped ({e})\n")
            result_info["phases"].append({"name": "clahe", "status": "failed", "error": str(e)})
    else:
        result_info["phases"].append({"name": "clahe", "status": "skipped"})

    img.save(img_output, "PNG", optimize=True)
    final_size = os.path.getsize(img_output)
    result_info["final_size"] = list(img.size)
    result_info["file_bytes"] = final_size

    sys.stderr.write(
        f"[pipeline] output: {os.path.basename(img_output)} "
        f"({img.size[0]}x{img.size[1]}, {final_size:,} bytes)\n"
    )

    return result_info


def main():
    args = parse_args()

    # Load SDXL pipeline once if needed
    pipe = None
    if not args.skip_sdxl:
        pipe = load_sdxl_pipeline(args.sdxl_model)

    if args.batch:
        # Batch mode: read JSON job list, process all with same pipeline
        with open(args.batch, "r") as f:
            jobs = json.load(f)

        sys.stderr.write(f"[batch] processing {len(jobs)} images\n")
        results = []
        for i, job in enumerate(jobs):
            sys.stderr.write(f"[batch] [{i + 1}/{len(jobs)}] {os.path.basename(job['input'])}\n")
            result = process_one(
                args,
                img_input=job["input"],
                img_output=job["output"],
                prompt=job.get("prompt", ""),
                seed=job.get("seed"),
                pipe=pipe,
            )
            results.append(result)

        json.dump(results, sys.stdout)
        sys.stdout.write("\n")
    else:
        # Single mode
        if not args.input or not args.output:
            sys.stderr.write("[error] --input and --output required in single mode\n")
            sys.exit(1)

        result = process_one(args, args.input, args.output, args.prompt, args.seed, pipe)
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")

    # Cleanup
    if pipe is not None:
        import torch
        del pipe
        if hasattr(torch, "mps"):
            torch.mps.empty_cache()


if __name__ == "__main__":
    main()
