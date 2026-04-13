import type { TranscriptSegment, ExtractedFrame } from "./youtube.js";
import { formatTime } from "./youtube.js";

// Phrases that indicate the speaker is referencing something visual
const VISUAL_CUE_PATTERNS = [
  /\bas you can see\b/i,
  /\blook at\b/i,
  /\blooking at\b/i,
  /\bhere (?:we|you|i) (?:can |)?see\b/i,
  /\bthis (?:is|shows?|displays?|demonstrates?)\b/i,
  /\bon (?:the )?screen\b/i,
  /\bin this (?:diagram|chart|graph|slide|image|screenshot|example|demo)\b/i,
  /\bshown here\b/i,
  /\blet me show\b/i,
  /\bif (?:we|you|i) look\b/i,
  /\bwatch (?:this|what|how|as)\b/i,
  /\bnotice (?:how|that|the)\b/i,
  /\bright here\b/i,
  /\bon the (?:left|right|top|bottom)\b/i,
  /\bthis part\b/i,
  /\bover here\b/i,
  /\blet's (?:take a )?look\b/i,
  /\bcheck (?:this|that) out\b/i,
  /\byou'll see\b/i,
  /\bpay attention to\b/i,
  /\bhighlighted\b/i,
  /\bpointing (?:to|at)\b/i,
  /\bclick(?:ing)? (?:on|here)\b/i,
  /\btype(?:ing)? (?:in|this)\b/i,
  /\bselect(?:ing)?\b/i,
  /\bdrag(?:ging)?\b/i,
  /\bscroll(?:ing)?\b/i,
];

export type VisualCue = {
  readonly timestamp: number;
  readonly text: string;
  readonly pattern: string;
};

export function detectVisualCues(
  segments: readonly TranscriptSegment[]
): readonly VisualCue[] {
  const cues: VisualCue[] = [];

  for (const segment of segments) {
    for (const pattern of VISUAL_CUE_PATTERNS) {
      if (pattern.test(segment.text)) {
        cues.push({
          timestamp: segment.start,
          text: segment.text,
          pattern: pattern.source,
        });
        break; // one cue per segment
      }
    }
  }

  return cues;
}

export type TranscriptChunk = {
  readonly startTime: number;
  readonly endTime: number;
  readonly text: string;
  readonly hasVisualCues: boolean;
  readonly visualCueTimestamps: readonly number[];
};

export function chunkTranscript(
  segments: readonly TranscriptSegment[],
  videoDuration: number,
  targetChunkSeconds = 30
): readonly TranscriptChunk[] {
  if (segments.length === 0) return [];

  const visualCues = detectVisualCues(segments);
  const visualCueSet = new Set(visualCues.map((c) => c.timestamp));

  const chunks: TranscriptChunk[] = [];
  let chunkStart = segments[0].start;
  let chunkTexts: string[] = [];
  let chunkVisualTimestamps: number[] = [];

  for (const segment of segments) {
    const elapsed = segment.start - chunkStart;

    if (elapsed >= targetChunkSeconds && chunkTexts.length > 0) {
      chunks.push({
        startTime: chunkStart,
        endTime: segment.start,
        text: chunkTexts.join(" "),
        hasVisualCues: chunkVisualTimestamps.length > 0,
        visualCueTimestamps: chunkVisualTimestamps,
      });

      chunkStart = segment.start;
      chunkTexts = [];
      chunkVisualTimestamps = [];
    }

    chunkTexts.push(segment.text);
    if (visualCueSet.has(segment.start)) {
      chunkVisualTimestamps.push(segment.start);
    }
  }

  // Flush remaining
  if (chunkTexts.length > 0) {
    const lastSeg = segments[segments.length - 1];
    chunks.push({
      startTime: chunkStart,
      endTime: lastSeg.start + lastSeg.duration,
      text: chunkTexts.join(" "),
      hasVisualCues: chunkVisualTimestamps.length > 0,
      visualCueTimestamps: chunkVisualTimestamps,
    });
  }

  return chunks;
}

// Select frame timestamps using three signal sources:
// 1. Visual cues in transcript (highest priority)
// 2. Scene changes detected by ffmpeg (high priority)
// 3. Regular intervals (fill remaining budget)
export function selectFrameTimestamps(
  chunks: readonly TranscriptChunk[],
  videoDuration: number,
  maxFrames: number,
  sceneChanges: readonly number[] = []
): readonly number[] {
  const timestamps = new Set<number>();

  // 1. Visual cue timestamps (highest priority)
  for (const chunk of chunks) {
    for (const ts of chunk.visualCueTimestamps) {
      timestamps.add(Math.round(ts));
    }
  }

  // 2. Scene change timestamps (high priority)
  for (const ts of sceneChanges) {
    timestamps.add(Math.round(ts));
  }

  // 3. Regular interval frames to fill gaps
  const intervalSeconds = computeInterval(videoDuration, maxFrames);
  for (let t = 0; t < videoDuration; t += intervalSeconds) {
    timestamps.add(Math.round(t));
  }

  // Cap at maxFrames with priority ordering
  const allTimestamps = [...timestamps].sort((a, b) => a - b);

  if (allTimestamps.length <= maxFrames) {
    return allTimestamps;
  }

  // Priority: visual cues > scene changes > regular intervals
  const visualTs = new Set(
    chunks.flatMap((c) => [...c.visualCueTimestamps]).map(Math.round)
  );
  const sceneTs = new Set(sceneChanges.map(Math.round));

  const tier1 = allTimestamps.filter((t) => visualTs.has(t));
  const tier2 = allTimestamps.filter(
    (t) => sceneTs.has(t) && !visualTs.has(t)
  );
  const tier3 = allTimestamps.filter(
    (t) => !visualTs.has(t) && !sceneTs.has(t)
  );

  const selected = [...tier1];
  let remaining = maxFrames - selected.length;

  if (remaining > 0 && tier2.length > 0) {
    const step = Math.max(1, Math.ceil(tier2.length / remaining));
    const sampled = tier2.filter((_, i) => i % step === 0).slice(0, remaining);
    selected.push(...sampled);
    remaining -= sampled.length;
  }

  if (remaining > 0 && tier3.length > 0) {
    const step = Math.max(1, Math.ceil(tier3.length / remaining));
    const sampled = tier3.filter((_, i) => i % step === 0).slice(0, remaining);
    selected.push(...sampled);
  }

  return selected.sort((a, b) => a - b);
}

function computeInterval(duration: number, maxFrames: number): number {
  const targetRegularFrames = Math.floor(maxFrames * 0.6);
  const interval = Math.max(15, Math.ceil(duration / targetRegularFrames));
  return Math.min(interval, 120);
}

// Dense LiveCC-style interleaving:
// For each frame, pair it with the exact transcript words spoken during that frame's time window.
// This is the closest approximation to Gemini's native multimodal approach.
export type InterleavedSegment = {
  readonly type: "frame";
  readonly timestamp: number;
  readonly frame: ExtractedFrame;
  readonly spokenDuring: string; // words spoken during this frame's window
  readonly isVisualCue: boolean;
  readonly isSceneChange: boolean;
} | {
  readonly type: "transcript-gap";
  readonly startTime: number;
  readonly endTime: number;
  readonly text: string;
};

export function buildDenseInterleave(
  frames: readonly ExtractedFrame[],
  segments: readonly TranscriptSegment[],
  options: {
    readonly visualCueTimestamps?: ReadonlySet<number>;
    readonly sceneChangeTimestamps?: ReadonlySet<number>;
  } = {}
): readonly InterleavedSegment[] {
  const {
    visualCueTimestamps = new Set<number>(),
    sceneChangeTimestamps = new Set<number>(),
  } = options;

  if (frames.length === 0) return [];

  const result: InterleavedSegment[] = [];
  let segmentIdx = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const windowStart = frame.timestamp;
    const windowEnd =
      i + 1 < frames.length
        ? frames[i + 1].timestamp
        : windowStart + 2; // last frame gets 2s window

    // Collect transcript text between previous frame and this one
    // (the "gap" text that was spoken before this frame but after the last)
    if (i > 0) {
      const prevEnd = frames[i - 1].timestamp + 1;
      const gapTexts: string[] = [];
      let gapStart = prevEnd;

      while (
        segmentIdx < segments.length &&
        segments[segmentIdx].start < windowStart
      ) {
        gapTexts.push(segments[segmentIdx].text);
        segmentIdx++;
      }

      if (gapTexts.length > 0) {
        result.push({
          type: "transcript-gap",
          startTime: gapStart,
          endTime: windowStart,
          text: gapTexts.join(" "),
        });
      }
    } else {
      // Before the first frame, collect any leading transcript
      const gapTexts: string[] = [];
      while (
        segmentIdx < segments.length &&
        segments[segmentIdx].start < windowStart
      ) {
        gapTexts.push(segments[segmentIdx].text);
        segmentIdx++;
      }
      if (gapTexts.length > 0) {
        result.push({
          type: "transcript-gap",
          startTime: segments[0].start,
          endTime: windowStart,
          text: gapTexts.join(" "),
        });
      }
    }

    // Collect words spoken during this frame's window
    const spokenTexts: string[] = [];
    const savedIdx = segmentIdx;
    let tempIdx = segmentIdx;
    while (
      tempIdx < segments.length &&
      segments[tempIdx].start < windowEnd
    ) {
      spokenTexts.push(segments[tempIdx].text);
      tempIdx++;
    }
    // Advance segmentIdx to after this window
    segmentIdx = tempIdx;

    const roundedTs = Math.round(frame.timestamp);
    result.push({
      type: "frame",
      timestamp: frame.timestamp,
      frame,
      spokenDuring: spokenTexts.join(" "),
      isVisualCue: visualCueTimestamps.has(roundedTs),
      isSceneChange: sceneChangeTimestamps.has(roundedTs),
    });
  }

  // Trailing transcript after last frame
  if (segmentIdx < segments.length) {
    const trailingTexts: string[] = [];
    const startTime = segments[segmentIdx].start;
    while (segmentIdx < segments.length) {
      trailingTexts.push(segments[segmentIdx].text);
      segmentIdx++;
    }
    if (trailingTexts.length > 0) {
      result.push({
        type: "transcript-gap",
        startTime,
        endTime: segments[segments.length - 1].start + segments[segments.length - 1].duration,
        text: trailingTexts.join(" "),
      });
    }
  }

  return result;
}

export function formatChunkHeader(chunk: TranscriptChunk): string {
  const start = formatTime(chunk.startTime);
  const end = formatTime(chunk.endTime);
  const visual = chunk.hasVisualCues ? " [visual content]" : "";
  return `### [${start} - ${end}]${visual}`;
}
