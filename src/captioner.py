"""
BLIP-2 frame captioner for youtube-mcp.

Reads a JSON array of {path, timestamp} from stdin, captions each frame,
outputs a JSON array of {timestamp, caption} to stdout.

Model is cached after first download (~3GB). Runs on MPS (Apple Silicon) or CPU.
"""

import json
import sys
import os
from pathlib import Path

def main():
    import torch
    from transformers import Blip2Processor, Blip2ForConditionalGeneration
    from PIL import Image

    # Determine device
    if torch.backends.mps.is_available():
        device = torch.device("mps")
        dtype = torch.float16
    elif torch.cuda.is_available():
        device = torch.device("cuda")
        dtype = torch.float16
    else:
        device = torch.device("cpu")
        dtype = torch.float32

    # Read input
    input_data = json.loads(sys.stdin.read())
    frames = input_data.get("frames", [])
    prompt = input_data.get("prompt", "")

    if not frames:
        json.dump({"captions": [], "model": "blip2-opt-2.7b", "device": str(device)}, sys.stdout)
        return

    # Load model (cached after first download)
    model_name = "Salesforce/blip2-opt-2.7b"
    sys.stderr.write(f"Loading {model_name} on {device}...\n")

    processor = Blip2Processor.from_pretrained(model_name)
    model = Blip2ForConditionalGeneration.from_pretrained(
        model_name,
        torch_dtype=dtype,
    )
    model = model.to(device)
    model.eval()

    sys.stderr.write(f"Model loaded. Processing {len(frames)} frames...\n")

    captions = []
    for i, frame_info in enumerate(frames):
        path = frame_info["path"]
        timestamp = frame_info["timestamp"]

        try:
            image = Image.open(path).convert("RGB")

            # BLIP-2 generates better captions with specific VQA-style prompts
            # We ask multiple questions and combine the answers for richer descriptions
            questions = [
                "Question: What is happening in this image? Answer:",
                "Question: What objects and text are visible? Answer:",
                "Question: Describe the setting and any people. Answer:",
            ] if not prompt else [prompt]

            parts = []
            for q in questions:
                inputs = processor(images=image, text=q, return_tensors="pt")
                inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}

                with torch.no_grad():
                    generated_ids = model.generate(
                        **inputs,
                        max_new_tokens=50,
                        num_beams=3,
                        early_stopping=True,
                    )

                answer = processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
                # Strip the question prefix if present in output
                if "Answer:" in answer:
                    answer = answer.split("Answer:")[-1].strip()
                if answer and answer not in parts:
                    parts.append(answer)

            caption = ". ".join(parts) if parts else "[no description generated]"

            captions.append({
                "timestamp": timestamp,
                "caption": caption,
            })

            if (i + 1) % 10 == 0:
                sys.stderr.write(f"  {i + 1}/{len(frames)} frames captioned\n")

        except Exception as e:
            sys.stderr.write(f"  Error captioning frame at {timestamp}s: {e}\n")
            captions.append({
                "timestamp": timestamp,
                "caption": f"[frame at {timestamp}s - captioning failed]",
            })

    sys.stderr.write(f"Done. {len(captions)} captions generated.\n")

    json.dump({
        "captions": captions,
        "model": model_name,
        "device": str(device),
    }, sys.stdout)


if __name__ == "__main__":
    main()
