import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getVideoInfo,
  getTranscript,
  extractFrames,
  getStreamUrl,
  detectSceneChanges,
  buildFrameGrid,
  formatTime,
} from "./youtube.js";
import {
  chunkTranscript,
  selectFrameTimestamps,
  formatChunkHeader,
  detectVisualCues,
  buildDenseInterleave,
} from "./analyzer.js";
import {
  describeFrames,
  deduplicateCaptions,
  buildDescribedVideo,
} from "./describe.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer(
  {
    name: "youtube-mcp",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "YouTube video analysis tools — model-agnostic Gemini-style video understanding. " +
      "Use watch_video to fully 'watch' a YouTube video with dense frame↔transcript interleaving, " +
      "scene-change detection, and timestamp-burned screenshots. " +
      "Use get_transcript for just the text, get_frames for specific timestamps, " +
      "get_video_info for metadata, and get_scene_overview for a visual summary grid.",
  }
);

// --- Tool: get_video_info ---
server.registerTool("get_video_info", {
  title: "Get Video Info",
  description:
    "Fetch metadata about a YouTube video: title, channel, duration, description, upload date, view count.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
  },
}, async ({ url }) => {
  try {
    const info = await getVideoInfo(url);
    const durationStr = formatTime(info.duration);
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `**${info.title}**`,
            `Channel: ${info.channel}`,
            `Duration: ${durationStr}`,
            `Uploaded: ${info.uploadDate}`,
            `Views: ${info.viewCount.toLocaleString()}`,
            ``,
            `**Description:**`,
            info.description.slice(0, 1000),
          ].join("\n"),
        },
      ],
    };
  } catch (error) {
    return toolError(`Failed to get video info: ${errorMessage(error)}`);
  }
});

// --- Tool: get_transcript ---
server.registerTool("get_transcript", {
  title: "Get Transcript",
  description:
    "Fetch the full timestamped transcript of a YouTube video. Returns text with timestamps.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
    language: z
      .string()
      .default("en")
      .describe("Language code for subtitles (default: en)"),
  },
}, async ({ url, language }) => {
  try {
    const segments = await getTranscript(url, language);
    const lines = segments.map(
      (s) => `[${formatTime(s.start)}] ${s.text}`
    );
    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  } catch (error) {
    return toolError(`Failed to get transcript: ${errorMessage(error)}`);
  }
});

// --- Tool: get_frames ---
server.registerTool("get_frames", {
  title: "Get Frames",
  description:
    "Extract frames from a YouTube video at specific timestamps. Returns images with burned-in timestamps.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
    timestamps: z
      .array(z.number())
      .describe("Array of timestamps in seconds to extract frames at"),
    width: z
      .number()
      .default(640)
      .describe("Frame width in pixels (default: 640)"),
  },
}, async ({ url, timestamps, width }) => {
  try {
    if (timestamps.length > 20) {
      return toolError("Maximum 20 frames per request. Use watch_video for full video analysis.");
    }
    const frames = await extractFrames(url, timestamps, { width, burnTimestamps: true });
    const content: CallToolResult["content"] = [];

    for (const frame of frames) {
      content.push({
        type: "text" as const,
        text: `Frame at ${formatTime(frame.timestamp)}:`,
      });
      content.push({
        type: "image" as const,
        data: frame.data,
        mimeType: frame.mimeType,
      });
    }

    if (content.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No frames could be extracted at the given timestamps." },
        ],
      };
    }

    return { content };
  } catch (error) {
    return toolError(`Failed to extract frames: ${errorMessage(error)}`);
  }
});

// --- Tool: get_scene_overview ---
server.registerTool("get_scene_overview", {
  title: "Get Scene Overview",
  description:
    "Get a visual overview grid of a YouTube video — a composite image showing frames at every " +
    "scene change, tiled into a single image with timestamps. Quick way to see what a video " +
    "covers without watching the whole thing.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
    max_scenes: z
      .number()
      .default(12)
      .describe("Maximum number of scene-change frames to include (default: 12)"),
    columns: z
      .number()
      .default(3)
      .describe("Number of columns in the grid (default: 3)"),
  },
}, async ({ url, max_scenes, columns }) => {
  try {
    const [info, streamUrl] = await Promise.all([
      getVideoInfo(url),
      getStreamUrl(url),
    ]);

    // Detect scene changes
    const rawScenes = await detectSceneChanges(url, {
      threshold: 0.3,
      maxScenes: max_scenes * 2, // get extra, then sample evenly
      streamUrl,
    });

    let sceneTimestamps: number[];

    // If scene detection found too few, fall back to regular intervals
    if (rawScenes.length < 4) {
      const interval = Math.max(5, Math.ceil(info.duration / max_scenes));
      sceneTimestamps = [];
      for (let t = 0; t < info.duration; t += interval) {
        sceneTimestamps.push(t);
        if (sceneTimestamps.length >= max_scenes) break;
      }
    } else {
      sceneTimestamps = [...rawScenes];
    }

    // Sample down to max_scenes
    if (sceneTimestamps.length > max_scenes) {
      const step = Math.ceil(sceneTimestamps.length / max_scenes);
      sceneTimestamps = sceneTimestamps.filter((_, i) => i % step === 0).slice(0, max_scenes);
    }

    // Extract frames with timestamps burned in
    const frames = await extractFrames(url, sceneTimestamps, {
      width: 320,
      burnTimestamps: true,
      streamUrl,
    });

    // Build composite grid
    const grid = await buildFrameGrid(frames, { columns, tileWidth: 320 });

    const content: CallToolResult["content"] = [];
    content.push({
      type: "text" as const,
      text: [
        `# Scene Overview: ${info.title}`,
        `**Channel:** ${info.channel} | **Duration:** ${formatTime(info.duration)}`,
        `**Scenes detected:** ${frames.length} | Timestamps: ${frames.map((f) => formatTime(f.timestamp)).join(", ")}`,
        ``,
      ].join("\n"),
    });

    if (grid) {
      content.push({
        type: "image" as const,
        data: grid.data,
        mimeType: grid.mimeType,
      });
    } else {
      // Fallback: individual frames
      for (const frame of frames) {
        content.push({
          type: "image" as const,
          data: frame.data,
          mimeType: frame.mimeType,
        });
      }
    }

    return { content };
  } catch (error) {
    return toolError(`Failed to get scene overview: ${errorMessage(error)}`);
  }
});

// --- Tool: watch_video ---
server.registerTool("watch_video", {
  title: "Watch Video",
  description:
    "Watch a YouTube video in segments. For short videos (<5 min), returns everything at once. " +
    "For longer videos, processes a segment at a time — call repeatedly with start_time to page " +
    "through the full video. Each segment returns dense frame↔transcript interleaving with " +
    "~1 frame every 5 seconds (close to Gemini's density). The response tells you how to " +
    "continue to the next segment.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
    start_time: z
      .number()
      .default(0)
      .describe("Start time in seconds (default: 0). Use this to page through long videos."),
    segment_duration: z
      .number()
      .default(0)
      .describe(
        "How many seconds to process (default: auto — 300s for long videos, full length for short ones). " +
        "Shorter segments = denser frame sampling within that segment."
      ),
    max_frames: z
      .number()
      .default(0)
      .describe(
        "Max frames for this segment (default: auto — calculated for ~1 frame per 5 seconds)."
      ),
    frame_width: z
      .number()
      .default(640)
      .describe("Frame width in pixels (default: 640)"),
  },
}, async ({ url, start_time, segment_duration, max_frames, frame_width }) => {
  try {
    // Step 1: Get video info + stream URL in parallel
    const [info, streamUrl] = await Promise.all([
      getVideoInfo(url),
      getStreamUrl(url),
    ]);

    // Step 2: Determine segment boundaries
    const isShortVideo = info.duration <= 300; // 5 min
    const segStart = start_time;
    const segDuration = segment_duration > 0
      ? segment_duration
      : isShortVideo
        ? info.duration
        : 180; // 3 min segments for long videos
    const segEnd = Math.min(segStart + segDuration, info.duration);
    const actualDuration = segEnd - segStart;

    // Target ~1 frame per 5 seconds within the segment
    const autoMaxFrames = Math.max(6, Math.min(60, Math.ceil(actualDuration / 5)));
    const effectiveMaxFrames = max_frames > 0 ? max_frames : autoMaxFrames;

    // Step 3: Get transcript + detect scene changes in parallel
    let allSegments;
    let sceneChanges: readonly number[] = [];

    const [transcriptResult, sceneResult] = await Promise.allSettled([
      getTranscript(url),
      detectSceneChanges(url, {
        threshold: 0.3,
        maxScenes: effectiveMaxFrames * 2,
        streamUrl,
      }),
    ]);

    if (transcriptResult.status === "fulfilled") {
      allSegments = transcriptResult.value;
    }

    if (sceneResult.status === "fulfilled") {
      // Filter scene changes to this segment
      sceneChanges = sceneResult.value.filter(
        (t) => t >= segStart && t < segEnd
      );
    }

    // Filter transcript to this segment
    const segments = allSegments?.filter(
      (s) => s.start >= segStart && s.start < segEnd
    );

    // No transcript for this segment
    if (!segments || segments.length === 0) {
      const result = await frameOnlyMode(url, info, effectiveMaxFrames, frame_width, sceneChanges, streamUrl, segStart, segEnd);
      return addContinuation(result, info, segEnd);
    }

    // Step 4: Select frame timestamps using all three signals
    const chunkSeconds = Math.min(computeChunkSize(actualDuration), 15);
    const chunks = chunkTranscript(segments, actualDuration, chunkSeconds);
    const frameTimestamps = selectFrameTimestamps(
      chunks,
      actualDuration,
      effectiveMaxFrames,
      sceneChanges
    );

    // Also add evenly spaced frames within the segment to ensure density
    const allTimestamps = new Set(frameTimestamps);
    const interval = Math.max(3, Math.ceil(actualDuration / effectiveMaxFrames));
    for (let t = segStart; t < segEnd; t += interval) {
      allTimestamps.add(Math.round(t));
    }
    const finalTimestamps = [...allTimestamps]
      .filter((t) => t >= segStart && t < segEnd)
      .sort((a, b) => a - b)
      .slice(0, effectiveMaxFrames);

    // Step 5: Extract frames with burned timestamps
    const frames = await extractFrames(url, finalTimestamps, {
      width: frame_width,
      burnTimestamps: true,
      streamUrl,
    });

    // Step 6: Build dense interleaved content
    const content: CallToolResult["content"] = [];

    const visualCues = detectVisualCues(segments);
    const visualCueSet = new Set(visualCues.map((c) => Math.round(c.timestamp)));
    const sceneChangeSet = new Set(sceneChanges.map(Math.round));
    const visualCueCount = visualCues.length;
    const hasMore = segEnd < info.duration;

    content.push({
      type: "text" as const,
      text: [
        `# ${info.title}`,
        `**Channel:** ${info.channel} | **Duration:** ${formatTime(info.duration)} | **Views:** ${info.viewCount.toLocaleString()}`,
        `**Segment:** ${formatTime(segStart)} - ${formatTime(segEnd)} (${Math.round(actualDuration)}s) | **Frames:** ${frames.length} (~1/${Math.round(actualDuration / frames.length)}s) | **Visual cues:** ${visualCueCount} | **Scene changes:** ${sceneChanges.length}`,
        hasMore ? `**Progress:** ${Math.round((segEnd / info.duration) * 100)}% | **Next segment:** call with start_time=${Math.round(segEnd)}` : `**Progress:** 100% complete`,
        ``,
        `---`,
      ].join("\n"),
    });

    const interleaved = buildDenseInterleave(frames, segments, {
      visualCueTimestamps: visualCueSet,
      sceneChangeTimestamps: sceneChangeSet,
    });

    for (const segment of interleaved) {
      if (segment.type === "transcript-gap") {
        content.push({
          type: "text" as const,
          text: `**[${formatTime(segment.startTime)} - ${formatTime(segment.endTime)}]** ${segment.text}`,
        });
      } else {
        const markers: string[] = [];
        if (segment.isVisualCue) markers.push("visual reference");
        if (segment.isSceneChange) markers.push("scene change");
        const markerStr = markers.length > 0 ? ` (${markers.join(", ")})` : "";

        if (segment.spokenDuring) {
          content.push({
            type: "text" as const,
            text: `**[${formatTime(segment.timestamp)}]${markerStr}** "${segment.spokenDuring}"`,
          });
        } else {
          content.push({
            type: "text" as const,
            text: `**[${formatTime(segment.timestamp)}]${markerStr}**`,
          });
        }

        content.push({
          type: "image" as const,
          data: segment.frame.data,
          mimeType: segment.frame.mimeType,
        });
      }
    }

    // Continuation hint
    if (hasMore) {
      content.push({
        type: "text" as const,
        text: `\n---\n**${Math.round(info.duration - segEnd)}s remaining.** To continue watching, call watch_video with start_time=${Math.round(segEnd)}`,
      });
    } else {
      content.push({
        type: "text" as const,
        text: `\n---\n**End of video.**`,
      });
    }

    return { content };
  } catch (error) {
    return toolError(`Failed to watch video: ${errorMessage(error)}`);
  }
});

// Fallback when no transcript is available
async function frameOnlyMode(
  url: string,
  info: Awaited<ReturnType<typeof getVideoInfo>>,
  maxFrames: number,
  width: number,
  sceneChanges: readonly number[],
  streamUrl: string,
  segStart = 0,
  segEnd = info.duration
): Promise<CallToolResult> {
  let timestamps: number[];
  const segScenes = sceneChanges.filter((t) => t >= segStart && t < segEnd);

  if (segScenes.length >= 4) {
    timestamps = [...segScenes];
    if (timestamps.length > maxFrames) {
      const step = Math.ceil(timestamps.length / maxFrames);
      timestamps = timestamps.filter((_, i) => i % step === 0).slice(0, maxFrames);
    }
  } else {
    const duration = segEnd - segStart;
    const interval = Math.max(5, Math.ceil(duration / maxFrames));
    timestamps = [];
    for (let t = segStart; t < segEnd; t += interval) {
      timestamps.push(t);
      if (timestamps.length >= maxFrames) break;
    }
  }

  const frames = await extractFrames(url, timestamps, {
    width,
    burnTimestamps: true,
    streamUrl,
  });

  const content: CallToolResult["content"] = [];

  content.push({
    type: "text" as const,
    text: [
      `# ${info.title}`,
      `**Channel:** ${info.channel} | **Duration:** ${formatTime(info.duration)}`,
      `**Segment:** ${formatTime(segStart)} - ${formatTime(segEnd)} | **Frames:** ${frames.length}`,
      ``,
      `> No transcript available for this segment. Frames extracted ${segScenes.length >= 4 ? "at scene changes" : "at regular intervals"}.`,
      `> Describe what you see in each frame to understand the video content.`,
      ``,
      `---`,
    ].join("\n"),
  });

  for (const frame of frames) {
    content.push({
      type: "text" as const,
      text: `**[${formatTime(frame.timestamp)}]**`,
    });
    content.push({
      type: "image" as const,
      data: frame.data,
      mimeType: frame.mimeType,
    });
  }

  return { content };
}

function addContinuation(
  result: CallToolResult,
  info: Awaited<ReturnType<typeof getVideoInfo>>,
  segEnd: number
): CallToolResult {
  if (segEnd < info.duration) {
    result.content.push({
      type: "text" as const,
      text: `\n---\n**${Math.round(info.duration - segEnd)}s remaining.** To continue watching, call watch_video with start_time=${Math.round(segEnd)}`,
    });
  }
  return result;
}

function computeChunkSize(duration: number): number {
  if (duration < 300) return 20;
  if (duration < 900) return 30;
  if (duration < 1800) return 45;
  return 60;
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// --- Tool: describe_video ---
server.registerTool("describe_video", {
  title: "Describe Video (Full Vision)",
  description:
    "Watch a YouTube video with FULL visual coverage using local BLIP-2 vision model. " +
    "Extracts frames at 1 FPS (or every N seconds), runs each through BLIP-2 locally to " +
    "generate text descriptions, deduplicates similar descriptions, then returns transcript " +
    "interleaved with visual descriptions as pure text. This lets you 'see' every moment " +
    "of the video without sending images — the entire output is text tokens. " +
    "First run downloads the model (~3GB). Requires the .venv to be set up.",
  inputSchema: {
    url: z.string().describe("YouTube video URL"),
    start_time: z
      .number()
      .default(0)
      .describe("Start time in seconds (default: 0)."),
    segment_duration: z
      .number()
      .default(0)
      .describe(
        "How many seconds to process (default: auto — full video if <10min, 300s segments otherwise)."
      ),
    fps: z
      .number()
      .default(0)
      .describe(
        "Frames per second to sample (default: auto — 1 FPS for short videos, 0.5 FPS for long). " +
        "Higher = more visual detail but slower."
      ),
    deduplicate: z
      .boolean()
      .default(true)
      .describe("Remove near-identical frame descriptions (default: true). Saves tokens for static content."),
  },
}, async ({ url, start_time, segment_duration, fps, deduplicate }) => {
  try {
    // Step 1: Get video info + stream URL + transcript in parallel
    const [info, streamUrl, transcriptResult] = await Promise.all([
      getVideoInfo(url),
      getStreamUrl(url),
      getTranscript(url).catch(() => null),
    ]);

    // Step 2: Determine segment
    const isShort = info.duration <= 600; // 10 min
    const segStart = start_time;
    const segDuration = segment_duration > 0
      ? segment_duration
      : isShort
        ? info.duration
        : 300;
    const segEnd = Math.min(segStart + segDuration, info.duration);
    const actualDuration = segEnd - segStart;

    // Step 3: Determine FPS
    const effectiveFps = fps > 0
      ? fps
      : actualDuration <= 300
        ? 1       // 1 FPS for <=5 min
        : actualDuration <= 600
          ? 0.5   // 1 frame/2s for 5-10 min
          : 0.33; // 1 frame/3s for 10+ min

    // Generate timestamps
    const interval = 1 / effectiveFps;
    const timestamps: number[] = [];
    for (let t = segStart; t < segEnd; t += interval) {
      timestamps.push(Math.round(t * 10) / 10);
    }

    // Step 4: Run BLIP-2 captioning
    const describeResult = await describeFrames(url, timestamps, {
      width: 384,
      streamUrl,
    });

    // Step 5: Deduplicate if requested
    const captions = deduplicate
      ? deduplicateCaptions(describeResult.captions)
      : describeResult.captions;

    // Step 6: Filter transcript to segment
    const segments = transcriptResult?.filter(
      (s) => s.start >= segStart && s.start < segEnd
    ) ?? [];

    // Step 7: Build interleaved text output
    const text = buildDescribedVideo(captions, segments, {
      title: info.title,
      channel: info.channel,
      duration: info.duration,
      model: describeResult.model,
      device: describeResult.device,
      segStart,
      segEnd,
    });

    const hasMore = segEnd < info.duration;
    const continuation = hasMore
      ? `\n\n---\n**${Math.round(info.duration - segEnd)}s remaining.** To continue, call describe_video with start_time=${Math.round(segEnd)}`
      : "\n\n---\n**End of video.**";

    const stats = [
      `\n\n---`,
      `**Stats:** ${timestamps.length} frames sampled → ${describeResult.captions.length} captioned → ${captions.length} unique (${Math.round((1 - captions.length / Math.max(1, describeResult.captions.length)) * 100)}% dedup)`,
      `**Token estimate:** ~${Math.round(text.length / 4)} tokens (vs ~${timestamps.length * 12000} tokens if sent as images — ${Math.round((timestamps.length * 12000) / Math.max(1, Math.round(text.length / 4)))}x savings)`,
    ].join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: text + stats + continuation,
        },
      ],
    };
  } catch (error) {
    return toolError(`Failed to describe video: ${errorMessage(error)}`);
  }
});

// --- Start the server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
