<p align="center">
  <img src="https://img.shields.io/badge/MCP-YouTube-red?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube MCP" />
  <img src="https://img.shields.io/badge/Gemini--Style-Video_Understanding-blue?style=for-the-badge" alt="Gemini-style" />
  <img src="https://img.shields.io/badge/Any_Model-Universal-green?style=for-the-badge" alt="Any Model" />
</p>

<h1 align="center">youtube-mcp</h1>

<p align="center">
  <strong>Give any AI the ability to watch YouTube videos.</strong><br/>
  Dense frame-transcript interleaving. Scene detection. Visual cue analysis.<br/>
  Gemini-style video understanding — for any model.
</p>

<p align="center">
  <a href="#-quick-install">Quick Install</a> &bull;
  <a href="#-how-it-works">How It Works</a> &bull;
  <a href="#-tools">Tools</a> &bull;
  <a href="#-ai-installer">AI Installer</a> &bull;
  <a href="#-examples">Examples</a>
</p>

---

## What is this?

An MCP server that lets AI assistants **actually watch** YouTube videos — not just read transcripts.

It extracts frames at scene changes and visual reference moments, pairs each frame with the exact words spoken at that timestamp, and returns everything as dense interleaved content. The AI sees what's on screen at the exact moment someone says "as you can see here."

**No existing YouTube MCP server does this.** Every other one is transcript-only. This is the first to combine transcript + vision.

### The Token Math

| Approach | 10 min video | Token cost |
|----------|-------------|------------|
| Gemini native (1 FPS, 258 tok/frame) | 600 frames | ~155K tokens |
| Sending raw JPEGs to any model | 600 frames | ~7.2M tokens |
| **youtube-mcp** (dense interleave, 1 frame/5s) | 120 frames | ~1.4M tokens |
| **youtube-mcp** describe mode (BLIP-2 → text) | 600 frames | **~18K tokens** |

Describe mode gives you **400x savings** over raw images — full visual coverage as pure text.

---

## Quick Install

### Prerequisites

```bash
brew install yt-dlp ffmpeg
```

### Setup

```bash
git clone https://github.com/coah80/youtube-mcp.git
cd youtube-mcp
bun install
```

### Add to Claude Code

Add to your `~/.mcp.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "bun",
      "args": ["run", "/path/to/youtube-mcp/src/index.ts"]
    }
  }
}
```

Then restart Claude Code.

### Optional: Enable describe mode (local BLIP-2)

This lets the AI "see" every second of a video as text descriptions — no images needed.

```bash
cd youtube-mcp
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python torch torchvision transformers accelerate pillow
```

First run downloads the BLIP-2 model (~3GB). Subsequent runs use the cached model.

---

## AI Installer

> **For AI assistants:** Copy and paste this into your MCP config to install youtube-mcp.

Add this to `~/.mcp.json` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "youtube": {
      "command": "bun",
      "args": ["run", "/path/to/youtube-mcp/src/index.ts"]
    }
  }
}
```

Replace `/path/to/youtube-mcp` with the actual clone path.

If the file already has other servers, just add the `"youtube"` key inside the existing `"mcpServers"` object.

---

## How It Works

```
YouTube URL
    │
    ├──→ yt-dlp ──→ Transcript (timestamped, word-level)
    │
    ├──→ yt-dlp ──→ Stream URL ──→ ffmpeg ──→ Frames
    │                                │
    │                    ┌────────────┼────────────┐
    │                    │            │            │
    │              Scene Change  Visual Cues  Regular
    │              Detection    in Transcript  Intervals
    │              (ffmpeg)     ("as you can   (fill gaps)
    │                           see here")
    │                    │            │            │
    │                    └────────────┼────────────┘
    │                                │
    │                    Frame Selection (prioritized)
    │                                │
    └──────────────────→ Dense Interleave
                              │
                   ┌──────────┴──────────┐
                   │                     │
              Image Mode            Describe Mode
           (raw screenshots)     (BLIP-2 captions)
                   │                     │
              Frame + "words         Text description
              spoken during          + "words spoken
              this frame"            during this frame"
```

### Visual Cue Detection

The analyzer scans transcript text for 25+ patterns indicating the speaker is referencing something visual:

| Pattern | Example |
|---------|---------|
| `as you can see` | "As you can see here, the API returns..." |
| `look at this` | "Look at this graph" |
| `on screen` | "What's on screen right now is..." |
| `click here` | "If you click here, it opens..." |
| `this diagram` | "In this diagram, we have..." |
| `notice how` | "Notice how the color changes" |

When detected, a frame is extracted at that exact timestamp — so the AI sees what the speaker was pointing at.

### Scene Change Detection

Uses ffmpeg's scene detection filter (`select=gt(scene,0.3)`) to find where the visual content actually changes. This means:
- Static talking-head sections get fewer frames (nothing's changing)
- Slide transitions, screen recordings, demos get more frames (lots changing)

### Segment-Based Processing

For videos longer than 5 minutes, `watch_video` processes in 3-minute segments with ~1 frame every 5 seconds. The AI calls it repeatedly:

```
watch_video(url) → first 3 min, 36 frames
watch_video(url, start_time=180) → next 3 min, 36 frames
watch_video(url, start_time=360) → next 3 min, 36 frames
...until the end
```

Each response tells the AI how to continue: `"To continue watching, call watch_video with start_time=360"`

---

## Tools

| Tool | What it does |
|------|-------------|
| **`watch_video`** | Dense frame↔transcript interleaving in segments. ~1 frame/5s. The full "watch" experience. |
| **`describe_video`** | Full visual coverage via local BLIP-2. Every frame described as text. 400x fewer tokens than images. |
| **`get_scene_overview`** | Composite grid image of scene changes. Quick visual summary of the whole video. |
| **`get_frames`** | Extract frames at specific timestamps. For drilling into moments. |
| **`get_transcript`** | Full timestamped transcript. |
| **`get_video_info`** | Video metadata (title, channel, duration, views, description). |

---

## Examples

### "Watch this video and summarize it"

The AI calls `watch_video` and gets interleaved content like:

```
[1:23] (scene change) "and here's where it gets interesting"
[screenshot of code editor]

[1:28] "if you look at this function right here"
[screenshot showing the function being discussed]

[1:33] (visual reference) "notice how the state updates"
[screenshot at the exact moment they reference the visual]
```

### "Describe this entire lecture for me"

The AI calls `describe_video` and gets pure text:

```
[0:00] [VISUAL] A title slide reading "Introduction to Neural Networks"
[0:00] Welcome everyone to today's lecture on neural networks.
[0:05] [VISUAL] A diagram showing interconnected nodes in layers
[0:05] We'll start with the basic architecture.
[0:10] [VISUAL] The same diagram with arrows highlighted between layers
[0:10] Each connection between nodes has a weight...
```

600 frames of a 10-minute video → ~18K tokens. Fits in any context window.

---

## Architecture

```
youtube-mcp/
├── src/
│   ├── index.ts        # MCP server — 6 tool definitions
│   ├── youtube.ts      # yt-dlp + ffmpeg operations (stream URL, frames, scenes)
│   ├── analyzer.ts     # Visual cue detection, chunking, dense interleaving
│   ├── describe.ts     # BLIP-2 integration (TypeScript wrapper)
│   └── captioner.py    # BLIP-2 inference (Python, runs on MPS/CUDA/CPU)
├── .venv/              # Python venv for BLIP-2 (optional)
├── package.json
├── tsconfig.json
└── README.md
```

### Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **MCP SDK:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Video:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org)
- **Vision (optional):** [BLIP-2](https://huggingface.co/Salesforce/blip2-opt-2.7b) via PyTorch on Apple MPS

---

## Compatibility

Works with any MCP-compatible AI assistant:

- **Claude Code** (CLI, Desktop, Web)
- **Claude Desktop**
- **Cursor**
- **Any future MCP host**

The image-based tools (`watch_video`, `get_frames`, `get_scene_overview`) require a vision-capable model.

The text-based tool (`describe_video`) works with **any model** — even text-only ones — because BLIP-2 converts all visuals to text locally.

---

## Roadmap

- [ ] **Gemini Flash proxy mode** — use Gemini Flash ($0.10/1M tokens) as a visual encoder for higher-quality frame descriptions than BLIP-2
- [ ] **Frame deduplication** — perceptual similarity hashing to skip near-identical frames
- [ ] **Keyframe extraction** — use ffmpeg I-frame detection instead of fixed intervals
- [ ] **Whisper integration** — local audio transcription when YouTube captions aren't available
- [ ] **Timestamp burning** — burn MM:SS into frame pixels (requires ffmpeg with libfreetype)
- [ ] **npm package** — `npx youtube-mcp` one-liner install

---

## Research

This project was informed by deep research into how Gemini, GPT-4o, and open-source tools handle video:

- **Gemini** processes video at 1 FPS using SigLIP-SO400M (258 tokens/frame) with native multimodal attention
- **GPT-4o** sends base64 JPEG frames via the vision API (~12K tokens/frame)
- **No existing YouTube MCP server** combines transcript + frame extraction — this is the first

Key references: [LiveCC (CVPR 2025)](https://github.com/showlab/livecc), [mcp-deep-video](https://dev.to/littler00t/teaching-an-llm-to-watch-video-a-general-purpose-pattern-for-frame-level-ai-analysis-2phm), [videostil](https://github.com/empirical-run/videostil), [llm-video-frames](https://github.com/simonw/llm-video-frames)

---

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/coah80">@coah80</a><br/>
  <sub>Give AI assistants the ability to watch YouTube. Star if this helped you.</sub>
</p>
