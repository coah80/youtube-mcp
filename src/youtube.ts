import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VideoInfo = {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly duration: number;
  readonly description: string;
  readonly thumbnail: string;
  readonly uploadDate: string;
  readonly viewCount: number;
};

export type TranscriptSegment = {
  readonly start: number;
  readonly duration: number;
  readonly text: string;
};

export type ExtractedFrame = {
  readonly timestamp: number;
  readonly data: string; // base64
  readonly mimeType: "image/jpeg";
};

function parseVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`Could not parse video ID from URL: ${url}`);
}

export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const result =
    await $`yt-dlp --dump-json --no-download ${url}`.text();
  const data = JSON.parse(result);

  return {
    id: data.id,
    title: data.title,
    channel: data.channel ?? data.uploader ?? "Unknown",
    duration: data.duration,
    description: data.description ?? "",
    thumbnail: data.thumbnail ?? "",
    uploadDate: data.upload_date ?? "",
    viewCount: data.view_count ?? 0,
  };
}

export async function getTranscript(
  url: string,
  language = "en"
): Promise<readonly TranscriptSegment[]> {
  const tmpDir = await mkdtemp(join(tmpdir(), "yt-transcript-"));

  try {
    // Try auto-generated subs first, then manual subs
    await $`yt-dlp --write-auto-sub --sub-lang ${language} --sub-format json3 --skip-download -o ${join(tmpDir, "sub")} ${url}`.quiet();

    const { Glob } = await import("bun");
    const glob = new Glob("*.json3");
    const files: string[] = [];
    for await (const file of glob.scan(tmpDir)) {
      files.push(join(tmpDir, file));
    }

    if (files.length === 0) {
      // Fallback: try manual subtitles
      await $`yt-dlp --write-sub --sub-lang ${language} --sub-format json3 --skip-download -o ${join(tmpDir, "sub")} ${url}`.quiet();
      for await (const file of glob.scan(tmpDir)) {
        files.push(join(tmpDir, file));
      }
    }

    if (files.length === 0) {
      throw new Error(
        `No subtitles found for language "${language}". Try a different language code.`
      );
    }

    const subFile = files[0];
    const content = await Bun.file(subFile).json();

    const segments: TranscriptSegment[] = [];
    const events = content.events ?? [];

    for (const event of events) {
      if (!event.segs) continue;

      const text = event.segs
        .map((s: { utf8?: string }) => s.utf8 ?? "")
        .join("")
        .trim();

      if (!text || text === "\n") continue;

      segments.push({
        start: (event.tStartMs ?? 0) / 1000,
        duration: (event.dDurationMs ?? 0) / 1000,
        text,
      });
    }

    return segments;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function getStreamUrl(url: string): Promise<string> {
  return $`yt-dlp -f "bv*[height<=720]/bv*/b" --get-url ${url}`
    .text()
    .then((t) => t.trim().split("\n")[0]);
}

export async function extractFrames(
  url: string,
  timestamps: readonly number[],
  options: {
    readonly width?: number;
    readonly burnTimestamps?: boolean;
    readonly streamUrl?: string;
  } = {}
): Promise<readonly ExtractedFrame[]> {
  if (timestamps.length === 0) return [];

  const { width = 640, burnTimestamps = true, streamUrl: providedUrl } = options;
  const tmpDir = await mkdtemp(join(tmpdir(), "yt-frames-"));

  try {
    const streamUrl = providedUrl ?? await getStreamUrl(url);
    const frames: ExtractedFrame[] = [];

    // Check if drawtext filter is available (requires libfreetype)
    const hasDrawtext = await $`ffmpeg -filters 2>/dev/null`.text()
      .then((t) => t.includes("drawtext"))
      .catch(() => false);

    // Build the video filter chain
    const buildVf = (ts: number): string => {
      const parts = [`scale=${width}:-1`];
      if (burnTimestamps && hasDrawtext) {
        const label = formatTime(ts).replace(/:/g, "\\:");
        parts.push(
          `drawtext=text='${label}':fontsize=18:fontcolor=white:borderw=1:bordercolor=black:x=w-tw-8:y=h-th-8:box=1:boxcolor=black@0.5:boxborderw=4`
        );
      }
      return parts.join(",");
    };

    // Extract frames in parallel batches
    const batchSize = 5;
    for (let i = 0; i < timestamps.length; i += batchSize) {
      const batch = timestamps.slice(i, i + batchSize);

      const promises = batch.map(async (ts, idx) => {
        const outPath = join(tmpDir, `frame_${i + idx}.jpg`);
        const timeStr = formatTimestamp(ts);
        const vf = buildVf(ts);

        await $`ffmpeg -ss ${timeStr} -i ${streamUrl} -vframes 1 -vf ${vf} -q:v 2 ${outPath} -y`.quiet();

        const fileData = await Bun.file(outPath).arrayBuffer();
        const base64 = Buffer.from(fileData).toString("base64");

        return {
          timestamp: ts,
          data: base64,
          mimeType: "image/jpeg" as const,
        };
      });

      const results = await Promise.allSettled(promises);
      for (const result of results) {
        if (result.status === "fulfilled") {
          frames.push(result.value);
        }
      }
    }

    return frames.sort((a, b) => a.timestamp - b.timestamp);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Detect scene changes in the video and return timestamps where visual content changes significantly
export async function detectSceneChanges(
  url: string,
  options: {
    readonly threshold?: number; // 0-1, lower = more sensitive (default: 0.3)
    readonly maxScenes?: number;
    readonly streamUrl?: string;
  } = {}
): Promise<readonly number[]> {
  const { threshold = 0.3, maxScenes = 100, streamUrl: providedUrl } = options;
  const tmpDir = await mkdtemp(join(tmpdir(), "yt-scenes-"));

  try {
    const streamUrl = providedUrl ?? await getStreamUrl(url);

    // Use ffmpeg scene detection — outputs frame timestamps where scene changes occur
    // Use nothrow to prevent shell errors from throwing
    const proc = $`ffmpeg -i ${streamUrl} -vf select=gt(scene\\,${threshold}),showinfo -vsync vfr -f null - 2>&1`.nothrow().quiet();
    const result = await proc.text();

    const timestamps: number[] = [];
    const ptsRegex = /pts_time:(\d+\.?\d*)/g;
    let match;
    while ((match = ptsRegex.exec(result)) !== null) {
      timestamps.push(parseFloat(match[1]));
      if (timestamps.length >= maxScenes) break;
    }

    return timestamps.sort((a, b) => a - b);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// Build a composite grid image from multiple frames
export async function buildFrameGrid(
  frames: readonly ExtractedFrame[],
  options: {
    readonly columns?: number;
    readonly tileWidth?: number;
  } = {}
): Promise<ExtractedFrame | null> {
  if (frames.length === 0) return null;
  if (frames.length === 1) return frames[0];

  const { columns = 3, tileWidth = 320 } = options;
  const tmpDir = await mkdtemp(join(tmpdir(), "yt-grid-"));

  try {
    // Write individual frames to disk
    const inputPaths: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const path = join(tmpDir, `tile_${i}.jpg`);
      await Bun.write(path, Buffer.from(frames[i].data, "base64"));
      inputPaths.push(path);
    }

    const rows = Math.ceil(frames.length / columns);
    const outPath = join(tmpDir, "grid.jpg");

    // Build ffmpeg filter for tiling
    const inputs = inputPaths.flatMap((p) => ["-i", p]);
    const cols = Math.min(columns, frames.length);

    // Use xstack for flexible grid layout
    const tileH = Math.round((tileWidth * 9) / 16); // assume 16:9
    const scaleFilters = inputPaths
      .map((_, i) => `[${i}:v]scale=${tileWidth}:${tileH}[s${i}]`)
      .join(";");

    // Build layout string for xstack
    const layouts: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      layouts.push(`${col * tileWidth}_${row * tileH}`);
    }

    const xstackInputs = inputPaths.map((_, i) => `[s${i}]`).join("");
    const filterComplex = `${scaleFilters};${xstackInputs}xstack=inputs=${frames.length}:layout=${layouts.join("|")}`;

    await $`ffmpeg ${inputs} -filter_complex ${filterComplex} -q:v 3 ${outPath} -y`.quiet();

    const fileData = await Bun.file(outPath).arrayBuffer();
    const base64 = Buffer.from(fileData).toString("base64");

    return {
      timestamp: frames[0].timestamp,
      data: base64,
      mimeType: "image/jpeg" as const,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
