import { $ } from "bun";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { TranscriptSegment } from "./youtube.js";
import { formatTime, getStreamUrl } from "./youtube.js";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const PYTHON_BIN = join(PROJECT_ROOT, ".venv", "bin", "python");
const CAPTIONER_SCRIPT = join(PROJECT_ROOT, "src", "captioner.py");

export type FrameCaption = {
  readonly timestamp: number;
  readonly caption: string;
};

export type DescribeResult = {
  readonly captions: readonly FrameCaption[];
  readonly model: string;
  readonly device: string;
};

// Extract frames at given timestamps and caption them with BLIP-2
export async function describeFrames(
  url: string,
  timestamps: readonly number[],
  options: {
    readonly width?: number;
    readonly streamUrl?: string;
    readonly prompt?: string;
  } = {}
): Promise<DescribeResult> {
  if (timestamps.length === 0) {
    return { captions: [], model: "blip2-opt-2.7b", device: "none" };
  }

  const { width = 384, streamUrl: providedUrl, prompt } = options;
  const tmpDir = await mkdtemp(join(tmpdir(), "yt-describe-"));

  try {
    const streamUrl = providedUrl ?? await getStreamUrl(url);

    // Extract frames to disk (smaller res for captioning — 384px is fine for BLIP-2)
    const frameInfos: Array<{ path: string; timestamp: number }> = [];

    const batchSize = 8;
    for (let i = 0; i < timestamps.length; i += batchSize) {
      const batch = timestamps.slice(i, i + batchSize);

      const promises = batch.map(async (ts, idx) => {
        const outPath = join(tmpDir, `frame_${i + idx}.jpg`);
        const h = Math.floor(ts / 3600);
        const m = Math.floor((ts % 3600) / 60);
        const s = Math.floor(ts % 60);
        const timeStr = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;

        await $`ffmpeg -ss ${timeStr} -i ${streamUrl} -vframes 1 -vf scale=${width}:-1 -q:v 4 ${outPath} -y`.quiet();

        return { path: outPath, timestamp: ts };
      });

      const results = await Promise.allSettled(promises);
      for (const result of results) {
        if (result.status === "fulfilled") {
          frameInfos.push(result.value);
        }
      }
    }

    frameInfos.sort((a, b) => a.timestamp - b.timestamp);

    // Call Python captioner
    const input = JSON.stringify({
      frames: frameInfos,
      ...(prompt ? { prompt } : {}),
    });

    const proc = Bun.spawn([PYTHON_BIN, CAPTIONER_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Write input to stdin
    proc.stdin.write(input);
    proc.stdin.end();

    // Read output
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (stderr) {
      // Log progress to stderr (visible in MCP server logs)
      process.stderr.write(stderr);
    }

    if (exitCode !== 0) {
      throw new Error(`Captioner failed (exit ${exitCode}): ${stderr}`);
    }

    const result: DescribeResult = JSON.parse(stdout);
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Deduplicate captions that are too similar (e.g., static talking head)
export function deduplicateCaptions(
  captions: readonly FrameCaption[],
  similarityThreshold = 0.85
): readonly FrameCaption[] {
  if (captions.length <= 1) return captions;

  const result: FrameCaption[] = [captions[0]];

  for (let i = 1; i < captions.length; i++) {
    const current = captions[i].caption.toLowerCase();
    const previous = result[result.length - 1].caption.toLowerCase();

    const similarity = jaccardSimilarity(current, previous);

    if (similarity < similarityThreshold) {
      result.push(captions[i]);
    } else {
      // Skip but note the time range covered
      // Keep the last unique caption, update nothing (immutable)
    }
  }

  return result;
}

// Simple word-level Jaccard similarity (good enough for caption dedup)
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// Build a full video description: transcript interleaved with frame captions
export function buildDescribedVideo(
  captions: readonly FrameCaption[],
  segments: readonly TranscriptSegment[],
  options: {
    readonly title: string;
    readonly channel: string;
    readonly duration: number;
    readonly model: string;
    readonly device: string;
    readonly segStart?: number;
    readonly segEnd?: number;
  }
): string {
  const { title, channel, duration, model, device, segStart = 0, segEnd = duration } = options;

  const lines: string[] = [];

  // Header
  lines.push(`# ${title}`);
  lines.push(`**Channel:** ${channel} | **Duration:** ${formatTime(duration)}`);
  lines.push(`**Segment:** ${formatTime(segStart)} - ${formatTime(segEnd)} | **Frames described:** ${captions.length} | **Model:** ${model} | **Device:** ${device}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Merge captions and transcript segments by timestamp
  let captionIdx = 0;
  let segmentIdx = 0;

  while (captionIdx < captions.length || segmentIdx < segments.length) {
    const captionTs = captionIdx < captions.length ? captions[captionIdx].timestamp : Infinity;
    const segmentTs = segmentIdx < segments.length ? segments[segmentIdx].start : Infinity;

    if (captionTs <= segmentTs) {
      // Emit frame description
      const cap = captions[captionIdx];
      lines.push(`**[${formatTime(cap.timestamp)}] [VISUAL]** ${cap.caption}`);
      lines.push("");
      captionIdx++;
    } else {
      // Emit transcript line
      const seg = segments[segmentIdx];
      lines.push(`**[${formatTime(seg.start)}]** ${seg.text}`);
      segmentIdx++;
    }
  }

  return lines.join("\n");
}
