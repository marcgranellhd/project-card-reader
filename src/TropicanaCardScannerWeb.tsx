import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  ScanLine,
  Trash2,
  Play,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Copy,
  Upload,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

type CardPattern = {
  id: string;
  label: string;
  pack: number;
  src: string;
};

type ScanHistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  source: "camera" | "image";
  score: number;
};

type PermissionStateLike = "granted" | "denied" | "prompt" | "unsupported" | "unknown";

type Roi = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type TemplateHashes = {
  title: Uint8Array;
  semis: Uint8Array;
  body: Uint8Array;
  numberHash: Uint8Array;
  numberPatch: Float32Array;
};

type LoadedTemplate = CardPattern & {
  templateId: string;
  source: "base" | "training";
  hashes: TemplateHashes;
};

type DetectionResult = {
  match: LoadedTemplate;
  score: number;
  titleScore: number;
  semisScore: number;
  bodyScore: number;
  numberScore: number;
  numberHashScore: number;
  numberPatchScore: number;
  scoreGap: number;
  numberGap: number;
  semisGap: number;
};

type CardPresenceMetrics = {
  valid: boolean;
  score: number;
  darkRatio: number;
  textEdgeRatio: number;
  boxWhiteness: number;
  boxContrast: number;
  reason: string;
};

type TrainingSample = {
  id: string;
  cardId: string;
  dataUrl: string;
  createdAt: number;
};

const CARD_PATTERNS: CardPattern[] = [
  { id: "tropicana-cherry-3", label: "Tropicana Cherry - Pack de 3", pack: 3, src: "/templates/pack3.jpg" },
  { id: "tropicana-cherry-5", label: "Tropicana Cherry - Pack de 5", pack: 5, src: "/templates/pack5.jpg" },
  { id: "tropicana-cherry-10", label: "Tropicana Cherry - Pack de 10", pack: 10, src: "/templates/pack10.jpg" },
  { id: "tropicana-cherry-25", label: "Tropicana Cherry - Pack de 25", pack: 25, src: "/templates/pack25.jpg" },
];

const TRAINING_STORAGE_KEY = "tropicana-training-samples-v1";
const MAX_TRAINING_SAMPLES = 140;

const CARD_SIZE = { width: 768, height: 1024 };
const HASH_SIZE = { width: 17, height: 16 };
const NUMBER_PATCH_SIZE = { width: 56, height: 34 };

const TITLE_ROI: Roi = { x: 0.05, y: 0.02, w: 0.58, h: 0.22 };
const SEMIS_ROI: Roi = { x: 0.02, y: 0.64, w: 0.26, h: 0.24 };
const BODY_ROI: Roi = { x: 0.05, y: 0.28, w: 0.62, h: 0.28 };
const NUMBER_ROI: Roi = { x: 0.035, y: 0.74, w: 0.18, h: 0.12 };
const CARD_TEXT_ROI: Roi = { x: 0.04, y: 0.03, w: 0.66, h: 0.58 };
const CARD_WHITE_BOX_ROI: Roi = { x: 0.02, y: 0.67, w: 0.96, h: 0.2 };

const MIN_TITLE_SCORE = 0.42;
const MIN_SEMIS_SCORE = 0.4;
const MIN_BODY_SCORE = 0.36;
const MIN_NUMBER_SCORE = 0.49;
const MIN_TOTAL_SCORE = 0.5;

const GENERAL_ROI_JITTERS: Array<{ dx: number; dy: number; scale: number }> = [
  { dx: 0, dy: 0, scale: 1 },
  { dx: -0.05, dy: 0, scale: 1 },
  { dx: 0.05, dy: 0, scale: 1 },
  { dx: 0, dy: -0.05, scale: 1 },
  { dx: 0, dy: 0.05, scale: 1 },
  { dx: 0, dy: 0, scale: 0.95 },
  { dx: 0, dy: 0, scale: 1.05 },
];

const NUMBER_ROI_JITTERS: Array<{ dx: number; dy: number; scale: number }> = [
  { dx: 0, dy: 0, scale: 1 },
  { dx: -0.03, dy: 0, scale: 1 },
  { dx: 0.03, dy: 0, scale: 1 },
  { dx: 0, dy: -0.03, scale: 1 },
  { dx: 0, dy: 0.03, scale: 1 },
  { dx: 0, dy: 0, scale: 0.95 },
  { dx: 0, dy: 0, scale: 1.05 },
];

const MIN_SCORE_GAP = 0.03;
const MIN_NUMBER_GAP = 0.045;
const MIN_SEMIS_GAP = 0.025;

const FAST_CONFIRM_SCORE = 0.66;
const FAST_CONFIRM_NUMBER = 0.66;

const MIN_CARD_DARK_RATIO = 0.22;
const MIN_CARD_TEXT_EDGE_RATIO = 0.085;
const MIN_CARD_BOX_WHITE_RATIO = 0.11;
const MIN_CARD_BOX_CONTRAST = 18;
const MIN_CARD_PRESENCE_SCORE = 0.5;

const CONFIRM_WINDOW_MS = 2600;
const DEDUPE_COOLDOWN_MS = 1800;
const SCAN_INTERVAL_MS = 320;

function formatTime() {
  return new Date().toLocaleTimeString();
}

function makeId() {
  if ("randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readTrainingSamples() {
  try {
    const raw = localStorage.getItem(TRAINING_STORAGE_KEY);
    if (!raw) return [] as TrainingSample[];
    const parsed = JSON.parse(raw) as TrainingSample[];
    if (!Array.isArray(parsed)) return [] as TrainingSample[];
    return parsed.filter((item) => {
      return (
        typeof item?.id === "string" &&
        typeof item?.cardId === "string" &&
        typeof item?.dataUrl === "string" &&
        typeof item?.createdAt === "number"
      );
    });
  } catch {
    return [] as TrainingSample[];
  }
}

function drawCover(source: CanvasImageSource, srcW: number, srcH: number, ctx: CanvasRenderingContext2D, dstW: number, dstH: number) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (dstW - drawW) / 2;
  const dy = (dstH - drawH) / 2;
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.drawImage(source, 0, 0, srcW, srcH, dx, dy, drawW, drawH);
}

function extractDHash(cardCanvas: HTMLCanvasElement, roi: Roi, scratchCanvas: HTMLCanvasElement): Uint8Array {
  scratchCanvas.width = HASH_SIZE.width;
  scratchCanvas.height = HASH_SIZE.height;
  const ctx = scratchCanvas.getContext("2d");
  if (!ctx) return new Uint8Array((HASH_SIZE.width - 1) * HASH_SIZE.height);

  const sx = Math.round(cardCanvas.width * roi.x);
  const sy = Math.round(cardCanvas.height * roi.y);
  const sw = Math.max(1, Math.round(cardCanvas.width * roi.w));
  const sh = Math.max(1, Math.round(cardCanvas.height * roi.h));

  ctx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, scratchCanvas.width, scratchCanvas.height);

  const image = ctx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
  const data = image.data;

  const gray = new Float32Array(HASH_SIZE.width * HASH_SIZE.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }

  const hash = new Uint8Array((HASH_SIZE.width - 1) * HASH_SIZE.height);
  let k = 0;
  for (let y = 0; y < HASH_SIZE.height; y += 1) {
    for (let x = 0; x < HASH_SIZE.width - 1; x += 1) {
      hash[k] = gray[y * HASH_SIZE.width + x] > gray[y * HASH_SIZE.width + x + 1] ? 1 : 0;
      k += 1;
    }
  }

  return hash;
}

function hashSimilarity(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length || a.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  return same / a.length;
}

function extractNormalizedPatch(
  cardCanvas: HTMLCanvasElement,
  roi: Roi,
  scratchCanvas: HTMLCanvasElement,
  patchW: number,
  patchH: number,
) {
  scratchCanvas.width = patchW;
  scratchCanvas.height = patchH;
  const ctx = scratchCanvas.getContext("2d");
  if (!ctx) return new Float32Array(patchW * patchH);

  const sx = Math.round(cardCanvas.width * roi.x);
  const sy = Math.round(cardCanvas.height * roi.y);
  const sw = Math.max(1, Math.round(cardCanvas.width * roi.w));
  const sh = Math.max(1, Math.round(cardCanvas.height * roi.h));

  ctx.clearRect(0, 0, patchW, patchH);
  ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, patchW, patchH);

  const image = ctx.getImageData(0, 0, patchW, patchH);
  const data = image.data;
  const patch = new Float32Array(patchW * patchH);

  let mean = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    patch[p] = gray;
    mean += gray;
  }
  mean /= patch.length || 1;

  let variance = 0;
  for (let i = 0; i < patch.length; i += 1) {
    const centered = patch[i] - mean;
    patch[i] = centered;
    variance += centered * centered;
  }
  const std = Math.sqrt(variance / (patch.length || 1)) || 1;

  for (let i = 0; i < patch.length; i += 1) patch[i] /= std;
  return patch;
}

function patchCosineSimilarity(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  const cosine = dot / Math.sqrt(normA * normB);
  return clamp((cosine + 1) / 2, 0, 1);
}

function computeHashes(cardCanvas: HTMLCanvasElement, scratchCanvas: HTMLCanvasElement): TemplateHashes {
  return {
    title: extractDHash(cardCanvas, TITLE_ROI, scratchCanvas),
    semis: extractDHash(cardCanvas, SEMIS_ROI, scratchCanvas),
    body: extractDHash(cardCanvas, BODY_ROI, scratchCanvas),
    numberHash: extractDHash(cardCanvas, NUMBER_ROI, scratchCanvas),
    numberPatch: extractNormalizedPatch(cardCanvas, NUMBER_ROI, scratchCanvas, NUMBER_PATCH_SIZE.width, NUMBER_PATCH_SIZE.height),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function jitterRoi(base: Roi, dx: number, dy: number, scale: number): Roi {
  const w = clamp(base.w * scale, 0.08, 0.98);
  const h = clamp(base.h * scale, 0.08, 0.98);
  const x = clamp(base.x + dx - (w - base.w) / 2, 0, 1 - w);
  const y = clamp(base.y + dy - (h - base.h) / 2, 0, 1 - h);
  return { x, y, w, h };
}

function bestRoiSimilarity(
  cardCanvas: HTMLCanvasElement,
  baseRoi: Roi,
  templateHash: Uint8Array,
  scratchCanvas: HTMLCanvasElement,
  jitters: Array<{ dx: number; dy: number; scale: number }>,
) {
  let best = 0;
  for (const jitter of jitters) {
    const roi = jitterRoi(baseRoi, jitter.dx, jitter.dy, jitter.scale);
    const currentHash = extractDHash(cardCanvas, roi, scratchCanvas);
    const score = hashSimilarity(currentHash, templateHash);
    if (score > best) best = score;
  }
  return best;
}

function bestRoiPatchSimilarity(
  cardCanvas: HTMLCanvasElement,
  baseRoi: Roi,
  templatePatch: Float32Array,
  scratchCanvas: HTMLCanvasElement,
  jitters: Array<{ dx: number; dy: number; scale: number }>,
) {
  let best = 0;
  for (const jitter of jitters) {
    const roi = jitterRoi(baseRoi, jitter.dx, jitter.dy, jitter.scale);
    const currentPatch = extractNormalizedPatch(cardCanvas, roi, scratchCanvas, NUMBER_PATCH_SIZE.width, NUMBER_PATCH_SIZE.height);
    const score = patchCosineSimilarity(currentPatch, templatePatch);
    if (score > best) best = score;
  }
  return best;
}

function analyzeRoiTone(
  cardCanvas: HTMLCanvasElement,
  roi: Roi,
  scratchCanvas: HTMLCanvasElement,
  width: number,
  height: number,
) {
  scratchCanvas.width = width;
  scratchCanvas.height = height;
  const ctx = scratchCanvas.getContext("2d");
  if (!ctx) {
    return {
      darkRatio: 0,
      brightRatio: 0,
      edgeRatio: 0,
      contrast: 0,
    };
  }

  const sx = Math.round(cardCanvas.width * roi.x);
  const sy = Math.round(cardCanvas.height * roi.y);
  const sw = Math.max(1, Math.round(cardCanvas.width * roi.w));
  const sh = Math.max(1, Math.round(cardCanvas.height * roi.h));

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const gray = new Float32Array(width * height);

  let dark = 0;
  let bright = 0;
  let mean = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    gray[p] = value;
    mean += value;
    if (value < 118) dark += 1;
    if (value > 178) bright += 1;
  }
  mean /= gray.length || 1;

  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  const contrast = Math.sqrt(variance / (gray.length || 1));

  let strongEdges = 0;
  let edgeChecks = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = gray[y * width + x];
      if (x + 1 < width) {
        if (Math.abs(center - gray[y * width + x + 1]) > 24) strongEdges += 1;
        edgeChecks += 1;
      }
      if (y + 1 < height) {
        if (Math.abs(center - gray[(y + 1) * width + x]) > 24) strongEdges += 1;
        edgeChecks += 1;
      }
    }
  }

  return {
    darkRatio: dark / (gray.length || 1),
    brightRatio: bright / (gray.length || 1),
    edgeRatio: strongEdges / (edgeChecks || 1),
    contrast,
  };
}

function evaluateCardPresence(cardCanvas: HTMLCanvasElement, scratchCanvas: HTMLCanvasElement): CardPresenceMetrics {
  const global = analyzeRoiTone(cardCanvas, { x: 0, y: 0, w: 1, h: 1 }, scratchCanvas, 128, 170);
  const text = analyzeRoiTone(cardCanvas, CARD_TEXT_ROI, scratchCanvas, 112, 96);
  const whiteBox = analyzeRoiTone(cardCanvas, CARD_WHITE_BOX_ROI, scratchCanvas, 136, 48);

  const darkScore = clamp((global.darkRatio - 0.16) / (0.5 - 0.16), 0, 1);
  const textScore = clamp((text.edgeRatio - 0.045) / (0.19 - 0.045), 0, 1);
  const boxWhiteScore = clamp((whiteBox.brightRatio - 0.06) / (0.34 - 0.06), 0, 1);
  const boxContrastScore = clamp((whiteBox.contrast - 10) / (46 - 10), 0, 1);
  const score = darkScore * 0.26 + textScore * 0.36 + boxWhiteScore * 0.22 + boxContrastScore * 0.16;

  let reason = "Patron de tarjeta insuficiente.";
  if (global.darkRatio < MIN_CARD_DARK_RATIO) {
    reason = "Fondo demasiado claro. No parece tarjeta.";
  } else if (text.edgeRatio < MIN_CARD_TEXT_EDGE_RATIO) {
    reason = "No se detecta suficiente texto impreso.";
  } else if (whiteBox.brightRatio < MIN_CARD_BOX_WHITE_RATIO) {
    reason = "No aparece la banda blanca inferior de la tarjeta.";
  } else if (whiteBox.contrast < MIN_CARD_BOX_CONTRAST) {
    reason = "Contraste bajo en la zona inferior.";
  }

  const valid =
    global.darkRatio >= MIN_CARD_DARK_RATIO &&
    text.edgeRatio >= MIN_CARD_TEXT_EDGE_RATIO &&
    whiteBox.brightRatio >= MIN_CARD_BOX_WHITE_RATIO &&
    whiteBox.contrast >= MIN_CARD_BOX_CONTRAST &&
    score >= MIN_CARD_PRESENCE_SCORE;

  return {
    valid,
    score,
    darkRatio: global.darkRatio,
    textEdgeRatio: text.edgeRatio,
    boxWhiteness: whiteBox.brightRatio,
    boxContrast: whiteBox.contrast,
    reason,
  };
}

function evaluateDetection(cardCanvas: HTMLCanvasElement, scratchCanvas: HTMLCanvasElement, templates: LoadedTemplate[]): DetectionResult | null {
  const templateCandidates: DetectionResult[] = [];

  for (const template of templates) {
    const titleScore = bestRoiSimilarity(cardCanvas, TITLE_ROI, template.hashes.title, scratchCanvas, GENERAL_ROI_JITTERS);
    const semisScore = bestRoiSimilarity(cardCanvas, SEMIS_ROI, template.hashes.semis, scratchCanvas, GENERAL_ROI_JITTERS);
    const bodyScore = bestRoiSimilarity(cardCanvas, BODY_ROI, template.hashes.body, scratchCanvas, GENERAL_ROI_JITTERS);
    const numberHashScore = bestRoiSimilarity(cardCanvas, NUMBER_ROI, template.hashes.numberHash, scratchCanvas, NUMBER_ROI_JITTERS);
    const numberPatchScore = bestRoiPatchSimilarity(cardCanvas, NUMBER_ROI, template.hashes.numberPatch, scratchCanvas, NUMBER_ROI_JITTERS);
    const numberScore = numberHashScore * 0.42 + numberPatchScore * 0.58;
    const score = titleScore * 0.16 + semisScore * 0.24 + bodyScore * 0.14 + numberScore * 0.46;

    const valid =
      titleScore >= MIN_TITLE_SCORE &&
      semisScore >= MIN_SEMIS_SCORE &&
      bodyScore >= MIN_BODY_SCORE &&
      numberScore >= MIN_NUMBER_SCORE &&
      score >= MIN_TOTAL_SCORE;

    if (!valid) continue;
    templateCandidates.push({
      match: template,
      score,
      titleScore,
      semisScore,
      bodyScore,
      numberScore,
      numberHashScore,
      numberPatchScore,
      scoreGap: 1,
      numberGap: 1,
      semisGap: 1,
    });
  }

  if (templateCandidates.length === 0) return null;

  // Keep the best template per card type (pack 3/5/10/25), so multiple training
  // samples of the same card strengthen detection instead of competing.
  const bestByCard = new Map<string, DetectionResult>();
  for (const candidate of templateCandidates) {
    const prev = bestByCard.get(candidate.match.id);
    if (!prev || candidate.score > prev.score) bestByCard.set(candidate.match.id, candidate);
  }

  const candidates = Array.from(bestByCard.values());
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];

  if (second) {
    const scoreGap = best.score - second.score;
    const numberGap = best.numberScore - second.numberScore;
    const semisGap = best.semisScore - second.semisScore;

    if (scoreGap < MIN_SCORE_GAP || numberGap < MIN_NUMBER_GAP || semisGap < MIN_SEMIS_GAP) {
      return null;
    }

    best.scoreGap = scoreGap;
    best.numberGap = numberGap;
    best.semisGap = semisGap;
  }

  if (best.numberScore < MIN_NUMBER_SCORE) {
    return null;
  }

  return best;
}

async function getCameraPermissionState(): Promise<PermissionStateLike> {
  try {
    if (!("permissions" in navigator) || !navigator.permissions?.query) return "unsupported";
    const result = await navigator.permissions.query({ name: "camera" as PermissionName });
    if (result.state === "granted" || result.state === "denied" || result.state === "prompt") return result.state;
    return "unknown";
  } catch {
    return "unsupported";
  }
}

function getReadableCameraError(error: unknown, secureContext: boolean) {
  const err = error as { name?: string } | undefined;
  const name = err?.name || "UnknownError";

  if (!secureContext) return "La camara esta bloqueada porque la pagina no esta en HTTPS o localhost.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Permiso de camara denegado o bloqueado por navegador/plataforma.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No se encontro ninguna camara disponible en este dispositivo.";
  if (name === "NotReadableError" || name === "TrackStartError") return "La camara existe, pero otra app o el sistema la esta usando.";
  if (name === "OverconstrainedError") return "La configuracion de camara solicitada no es compatible con este dispositivo.";
  return `No se pudo acceder a la camara (${name}).`;
}

export default function TropicanaCardScannerWeb() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const trainingFileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const isBusyRef = useRef(false);
  const lastAcceptedRef = useRef<{ id: string; at: number } | null>(null);
  const pendingRef = useRef<{ id: string; count: number; at: number; required: number } | null>(null);

  const [templates, setTemplates] = useState<LoadedTemplate[]>([]);
  const [templatesReady, setTemplatesReady] = useState(false);
  const [viewMode, setViewMode] = useState<"scanner" | "training">("scanner");
  const [trainingSamples, setTrainingSamples] = useState<TrainingSample[]>(() => readTrainingSamples());
  const [selectedTrainingCardId, setSelectedTrainingCardId] = useState(CARD_PATTERNS[0]?.id ?? "");

  const [cameraReady, setCameraReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Cargando plantillas...");
  const [currentMatch, setCurrentMatch] = useState<string | null>(null);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const [cameraSupported, setCameraSupported] = useState(() => Boolean(navigator.mediaDevices?.getUserMedia));
  const [secureContext, setSecureContext] = useState(() => window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const [permissionState, setPermissionState] = useState<PermissionStateLike>("unknown");
  const [lastError, setLastError] = useState<string | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isFeedbackOn, setIsFeedbackOn] = useState(false);

  const [debugBest, setDebugBest] = useState("--");
  const [debugScore, setDebugScore] = useState(0);
  const [debugTitle, setDebugTitle] = useState(0);
  const [debugSemis, setDebugSemis] = useState(0);
  const [debugBody, setDebugBody] = useState(0);
  const [debugNumber, setDebugNumber] = useState(0);
  const [debugCardPresence, setDebugCardPresence] = useState(0);
  const [debugCardText, setDebugCardText] = useState(0);
  const [debugCardBox, setDebugCardBox] = useState(0);

  const totals = useMemo(() => {
    return history.reduce<Record<string, number>>((acc, item) => {
      acc[item.id] = (acc[item.id] || 0) + 1;
      return acc;
    }, {});
  }, [history]);

  const trainingTotals = useMemo(() => {
    return trainingSamples.reduce<Record<string, number>>((acc, item) => {
      acc[item.cardId] = (acc[item.cardId] || 0) + 1;
      return acc;
    }, {});
  }, [trainingSamples]);

  const trainingSamplesSorted = useMemo(() => {
    return [...trainingSamples].sort((a, b) => b.createdAt - a.createdAt);
  }, [trainingSamples]);

  useEffect(() => {
    try {
      localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(trainingSamples));
    } catch {
      // Ignore storage errors.
    }
  }, [trainingSamples]);

  useEffect(() => {
    setSecureContext(window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    setCameraSupported(Boolean(navigator.mediaDevices?.getUserMedia));
    getCameraPermissionState().then(setPermissionState);

    return () => {
      if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioContextRef.current) void audioContextRef.current.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadTemplates = async () => {
      const loaded: LoadedTemplate[] = [];
      const scratch = document.createElement("canvas");

      for (const card of CARD_PATTERNS) {
        try {
          const img = new Image();
          img.src = `${card.src}?v=3`;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("template_load_error"));
          });

          const cardCanvas = document.createElement("canvas");
          cardCanvas.width = CARD_SIZE.width;
          cardCanvas.height = CARD_SIZE.height;
          const ctx = cardCanvas.getContext("2d");
          if (!ctx) continue;

          drawCover(img, img.naturalWidth, img.naturalHeight, ctx, cardCanvas.width, cardCanvas.height);
          loaded.push({
            ...card,
            templateId: `base-${card.id}`,
            source: "base",
            hashes: computeHashes(cardCanvas, scratch),
          });
        } catch {
          // Skip missing templates.
        }
      }

      for (const sample of trainingSamples) {
        const baseCard = CARD_PATTERNS.find((card) => card.id === sample.cardId);
        if (!baseCard) continue;

        try {
          const img = new Image();
          img.src = sample.dataUrl;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("training_template_load_error"));
          });

          const cardCanvas = document.createElement("canvas");
          cardCanvas.width = CARD_SIZE.width;
          cardCanvas.height = CARD_SIZE.height;
          const ctx = cardCanvas.getContext("2d");
          if (!ctx) continue;

          drawCover(img, img.naturalWidth, img.naturalHeight, ctx, cardCanvas.width, cardCanvas.height);
          loaded.push({
            ...baseCard,
            templateId: `training-${sample.id}`,
            source: "training",
            hashes: computeHashes(cardCanvas, scratch),
          });
        } catch {
          // Skip invalid training sample.
        }
      }

      if (cancelled) return;
      setTemplates(loaded);
      const cardVarieties = new Set(loaded.map((template) => template.id)).size;
      setTemplatesReady(loaded.length >= 2);
      setStatus(
        loaded.length >= 2
          ? `Plantillas cargadas: ${loaded.length} (${cardVarieties} tipos, ${trainingSamples.length} entrenadas).`
          : "No hay suficientes plantillas cargadas.",
      );
    };

    void loadTemplates();

    return () => {
      cancelled = true;
    };
  }, [trainingSamples]);

  const getRequiredConfirmations = (detection: DetectionResult) => {
    const fastTrack =
      detection.score >= FAST_CONFIRM_SCORE &&
      detection.numberScore >= FAST_CONFIRM_NUMBER &&
      detection.scoreGap >= MIN_SCORE_GAP * 1.8 &&
      detection.numberGap >= MIN_NUMBER_GAP * 1.8;
    return fastTrack ? 2 : 3;
  };

  const playFeedback = () => {
    setIsFeedbackOn(true);
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setIsFeedbackOn(false), 240);
    if ("vibrate" in navigator) navigator.vibrate?.(80);

    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContextRef.current) audioContextRef.current = new AudioCtx();
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") void ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(980, ctx.currentTime);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.14);
    } catch {
      // Ignore audio error.
    }
  };

  const acceptDetection = (detection: DetectionResult, source: "camera" | "image") => {
    const now = Date.now();
    const last = lastAcceptedRef.current;
    if (source === "camera" && last && last.id === detection.match.id && now - last.at < DEDUPE_COOLDOWN_MS) {
      setStatus(`Detectado otra vez ${detection.match.label}, ignorado para evitar duplicados.`);
      return;
    }

    lastAcceptedRef.current = { id: detection.match.id, at: now };
    pendingRef.current = null;
    setCurrentMatch(detection.match.label);
    setStatus(`Tarjeta detectada: ${detection.match.label}`);
    playFeedback();

    setHistory((prev) => [
      {
        id: detection.match.id,
        label: detection.match.label,
        timestamp: formatTime(),
        source,
        score: Math.round(detection.score * 100),
      },
      ...prev,
    ]);
  };

  const processCandidate = (detection: DetectionResult | null, source: "camera" | "image", noMatchStatus?: string) => {
    if (!detection) {
      setCurrentMatch(null);
      if (source === "camera") setStatus(noMatchStatus || "Escaneando... sin coincidencia valida.");
      if (source === "image" && noMatchStatus) setStatus(noMatchStatus);
      if (pendingRef.current && Date.now() - pendingRef.current.at > CONFIRM_WINDOW_MS) pendingRef.current = null;
      setDebugBest("--");
      setDebugScore(0);
      setDebugTitle(0);
      setDebugSemis(0);
      setDebugBody(0);
      setDebugNumber(0);
      return;
    }

    setDebugBest(detection.match.label);
    setDebugScore(Math.round(detection.score * 100));
    setDebugTitle(Math.round(detection.titleScore * 100));
    setDebugSemis(Math.round(detection.semisScore * 100));
    setDebugBody(Math.round(detection.bodyScore * 100));
    setDebugNumber(Math.round(detection.numberScore * 100));

    if (source === "image") {
      acceptDetection(detection, source);
      return;
    }

    const required = getRequiredConfirmations(detection);
    const pending = pendingRef.current;
    const now = Date.now();
    if (pending && pending.id === detection.match.id && now - pending.at <= CONFIRM_WINDOW_MS) {
      const nextCount = pending.count + 1;
      const requiredCount = Math.max(pending.required, required);
      pendingRef.current = { id: pending.id, count: nextCount, at: now, required: requiredCount };
      if (nextCount >= requiredCount) {
        acceptDetection(detection, source);
      } else {
        setStatus(`Posible ${detection.match.label}. Confirmando ${nextCount}/${requiredCount}...`);
      }
      return;
    }

    pendingRef.current = { id: detection.match.id, count: 1, at: now, required };
    setStatus(`Posible ${detection.match.label}. Confirmando 1/${required}...`);
  };

  const detectFromCardCanvas = (source: "camera" | "image") => {
    const cardCanvas = cardCanvasRef.current;
    if (!cardCanvas || templates.length === 0) return;
    if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement("canvas");
    const cardPresence = evaluateCardPresence(cardCanvas, scratchCanvasRef.current);
    setDebugCardPresence(Math.round(cardPresence.score * 100));
    setDebugCardText(Math.round(cardPresence.textEdgeRatio * 100));
    setDebugCardBox(Math.round(cardPresence.boxWhiteness * 100));

    if (!cardPresence.valid) {
      processCandidate(null, source, source === "camera" ? cardPresence.reason : `Imagen descartada: ${cardPresence.reason}`);
      return;
    }

    const detection = evaluateDetection(cardCanvas, scratchCanvasRef.current, templates);
    processCandidate(detection, source);
  };

  const drawCurrentCardFrame = () => {
    if (!videoRef.current || !cardCanvasRef.current) return false;
    const video = videoRef.current;
    const cardCanvas = cardCanvasRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return false;
    const ctx = cardCanvas.getContext("2d");
    if (!ctx) return false;

    cardCanvas.width = CARD_SIZE.width;
    cardCanvas.height = CARD_SIZE.height;

    let cropW = Math.round(video.videoWidth * 0.78);
    let cropH = Math.round((cropW * 4) / 3);
    if (cropH > Math.round(video.videoHeight * 0.92)) {
      cropH = Math.round(video.videoHeight * 0.92);
      cropW = Math.round((cropH * 3) / 4);
    }

    const cropX = Math.max(0, Math.round((video.videoWidth - cropW) / 2));
    const cropY = Math.max(0, Math.round((video.videoHeight - cropH) / 2));

    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cardCanvas.width, cardCanvas.height);
    return true;
  };

  const detectFromVideo = async () => {
    if (!videoRef.current || !cardCanvasRef.current || isBusyRef.current || templates.length === 0) return;

    isBusyRef.current = true;
    try {
      if (!drawCurrentCardFrame()) return;
      detectFromCardCanvas("camera");
    } finally {
      isBusyRef.current = false;
    }
  };

  const startScanning = () => {
    if (viewMode !== "scanner" || !cameraReady || !templatesReady) return;
    if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
    setIsRunning(true);
    setStatus("Escaneo visual rapido activo.");
    void detectFromVideo();
    scanTimerRef.current = window.setInterval(() => {
      void detectFromVideo();
    }, SCAN_INTERVAL_MS);
  };

  const startCamera = async () => {
    setLastError(null);
    if (!cameraSupported) {
      setStatus("Este navegador no soporta acceso a camara.");
      setLastError("No existe navigator.mediaDevices.getUserMedia en este entorno.");
      return;
    }
    if (!secureContext) {
      setStatus("La camara no se puede abrir aqui porque el sitio no esta en HTTPS o localhost.");
      setLastError("Contexto inseguro: la mayoria de navegadores bloquean la camara fuera de HTTPS/localhost.");
      return;
    }

    try {
      setStatus("Solicitando acceso a la camara...");
      setPermissionState(await getCameraPermissionState());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      pendingRef.current = null;
      lastAcceptedRef.current = null;
      setCameraReady(true);
      setPermissionState("granted");
      setStatus("Camara activa. Escaneo automatico encendido.");
    } catch (error) {
      const message = getReadableCameraError(error, secureContext);
      setCameraReady(false);
      setPermissionState(await getCameraPermissionState());
      setLastError(message);
      setStatus(`${message} Usa HTTPS/localhost o sube una imagen como plan B.`);
    }
  };

  useEffect(() => {
    if (!templatesReady || !cameraSupported || !secureContext || cameraReady) return;
    void startCamera();
  }, [templatesReady, cameraSupported, secureContext, cameraReady]);

  useEffect(() => {
    if (!videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play().catch(() => undefined);
  }, [viewMode, cameraReady]);

  useEffect(() => {
    if (viewMode === "training") {
      if (scanTimerRef.current) {
        window.clearInterval(scanTimerRef.current);
        scanTimerRef.current = null;
      }
      if (isRunning) setIsRunning(false);
      return;
    }

    if (cameraReady && templatesReady && !isRunning) startScanning();
  }, [cameraReady, templatesReady, isRunning, viewMode]);

  const clearHistory = () => {
    setHistory([]);
    setCurrentMatch(null);
    pendingRef.current = null;
    setStatus("Lista limpiada.");
  };

  const copySummary = async () => {
    const summary = history.map((item, idx) => `${idx + 1}. ${item.label} - ${item.timestamp} - ${item.source} - ${item.score}%`).join("\n");
    try {
      await navigator.clipboard.writeText(summary || "Sin registros.");
      setStatus("Resumen copiado al portapapeles.");
    } catch {
      setStatus("No se pudo copiar el resumen.");
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !cardCanvasRef.current || templates.length === 0) return;

    setIsProcessingImage(true);
    setLastError(null);
    setStatus("Procesando imagen subida...");
    try {
      const imageUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = imageUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image_load_error"));
      });

      const cardCanvas = cardCanvasRef.current;
      cardCanvas.width = CARD_SIZE.width;
      cardCanvas.height = CARD_SIZE.height;
      const ctx = cardCanvas.getContext("2d");
      if (!ctx) throw new Error("canvas_context_error");
      drawCover(image, image.naturalWidth, image.naturalHeight, ctx, cardCanvas.width, cardCanvas.height);
      detectFromCardCanvas("image");
      URL.revokeObjectURL(imageUrl);
    } catch {
      setLastError("No se pudo procesar la imagen subida.");
      setStatus("Error al procesar la imagen subida.");
    } finally {
      setIsProcessingImage(false);
      event.target.value = "";
    }
  };

  const addTrainingSample = (cardId: string, dataUrl: string) => {
    const card = CARD_PATTERNS.find((item) => item.id === cardId);
    setTrainingSamples((prev) => [{ id: makeId(), cardId, dataUrl, createdAt: Date.now() }, ...prev].slice(0, MAX_TRAINING_SAMPLES));
    setStatus(`Muestra guardada para ${card?.label ?? cardId}.`);
  };

  const captureTrainingFromCamera = () => {
    if (!selectedTrainingCardId) {
      setStatus("Selecciona el tipo de pack antes de entrenar.");
      return;
    }
    if (!cameraReady) {
      setStatus("Activa la camara primero para capturar muestras.");
      return;
    }
    if (!cardCanvasRef.current) {
      setStatus("No se pudo preparar el area de captura.");
      return;
    }
    const ok = drawCurrentCardFrame();
    if (!ok) {
      setStatus("No hay frame de camara disponible.");
      return;
    }
    const dataUrl = cardCanvasRef.current.toDataURL("image/jpeg", 0.92);
    addTrainingSample(selectedTrainingCardId, dataUrl);
  };

  const handleTrainingUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !cardCanvasRef.current) return;
    if (!selectedTrainingCardId) {
      setStatus("Selecciona el tipo de pack antes de subir muestras.");
      event.target.value = "";
      return;
    }

    setIsProcessingImage(true);
    setStatus("Procesando muestra para entrenamiento...");
    try {
      const imageUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = imageUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image_load_error"));
      });

      const cardCanvas = cardCanvasRef.current;
      cardCanvas.width = CARD_SIZE.width;
      cardCanvas.height = CARD_SIZE.height;
      const ctx = cardCanvas.getContext("2d");
      if (!ctx) throw new Error("canvas_context_error");
      drawCover(image, image.naturalWidth, image.naturalHeight, ctx, cardCanvas.width, cardCanvas.height);

      const dataUrl = cardCanvas.toDataURL("image/jpeg", 0.92);
      addTrainingSample(selectedTrainingCardId, dataUrl);
      URL.revokeObjectURL(imageUrl);
    } catch {
      setStatus("No se pudo procesar la muestra de entrenamiento.");
    } finally {
      setIsProcessingImage(false);
      event.target.value = "";
    }
  };

  const deleteTrainingSample = (sampleId: string) => {
    setTrainingSamples((prev) => prev.filter((sample) => sample.id !== sampleId));
    setStatus("Muestra eliminada.");
  };

  const clearTrainingByCard = (cardId: string) => {
    setTrainingSamples((prev) => prev.filter((sample) => sample.cardId !== cardId));
    const card = CARD_PATTERNS.find((item) => item.id === cardId);
    setStatus(`Entrenamiento borrado para ${card?.label ?? cardId}.`);
  };

  const clearAllTraining = () => {
    setTrainingSamples([]);
    setStatus("Todas las muestras de entrenamiento fueron eliminadas.");
  };

  const totalScans = history.length;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto mb-6 flex max-w-7xl flex-wrap gap-2">
        <Button className="rounded-2xl" variant={viewMode === "scanner" ? "default" : "outline"} onClick={() => setViewMode("scanner")}>Escaner</Button>
        <Button className="rounded-2xl" variant={viewMode === "training" ? "default" : "outline"} onClick={() => setViewMode("training")}>Entrenamiento</Button>
      </div>

      {viewMode === "scanner" ? (
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.35fr_0.95fr]">
          <Card className="overflow-hidden rounded-3xl border-0 shadow-xl">
            <CardHeader className="border-b bg-white">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <Camera className="h-6 w-6" />
                    Escaner visual · Tropicana Cherry
                  </CardTitle>
                  <p className="mt-2 text-sm text-slate-600">Comparacion por plantillas reales, sin OCR. Si no coincide con una foto valida, se descarta.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void startCamera()} disabled={!templatesReady || cameraReady} variant="outline" className="rounded-2xl">
                    <Play className="mr-2 h-4 w-4" />
                    Reintentar camara
                  </Button>
                  <Button variant="outline" className="rounded-2xl" onClick={() => fileInputRef.current?.click()} disabled={isProcessingImage || !templatesReady}>
                    <Upload className="mr-2 h-4 w-4" />
                    Subir imagen
                  </Button>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-4 p-4 md:p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <Card className="rounded-3xl border-slate-200 shadow-sm md:col-span-2">
                  <CardContent className="p-4">
                    <div className="relative overflow-hidden rounded-3xl bg-slate-900">
                      <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                        <div className={`relative w-full max-w-md rounded-[2rem] border-4 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)] transition-all duration-150 ${isFeedbackOn ? "scale-105 border-lime-300 bg-lime-200/10" : "border-emerald-400/80"}`}>
                          <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-emerald-300/90" />
                        </div>
                      </div>
                      {isFeedbackOn ? <div className="absolute right-3 top-3 rounded-xl bg-lime-400 px-3 py-1.5 text-xs font-bold text-slate-900">DETECTADO</div> : null}
                      <div className="absolute bottom-3 left-3 right-3 rounded-2xl bg-black/55 px-4 py-3 text-sm text-white backdrop-blur-sm">
                        <div className="flex items-center gap-2 font-medium">
                          <ScanLine className="h-4 w-4" />
                          Estado
                        </div>
                        <div className="mt-1 text-white/90">{status}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-slate-200 shadow-sm">
                  <CardContent className="space-y-3 p-4">
                    <div className="text-sm font-semibold text-slate-700">Entorno</div>
                    <div className="space-y-2 text-sm text-slate-600">
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Plantillas</span><Badge variant={templatesReady ? "default" : "destructive"} className="rounded-xl">{templates.length}</Badge></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>HTTPS / localhost</span><Badge variant={secureContext ? "default" : "destructive"} className="rounded-xl">{secureContext ? "Si" : "No"}</Badge></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Permiso camara</span><Badge variant={permissionState === "granted" ? "default" : permissionState === "denied" ? "destructive" : "secondary"} className="rounded-xl">{permissionState}</Badge></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Score total</span><Badge variant={debugScore >= 60 ? "default" : "secondary"} className="rounded-xl">{debugScore}%</Badge></div>
                    </div>

                    {lastError ? (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        <div className="flex items-start gap-2 font-medium"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />Problema detectado</div>
                        <div className="mt-2 leading-6">{lastError}</div>
                      </div>
                    ) : null}

                    <div>
                      <div className="text-sm font-semibold text-slate-700">Ultima deteccion</div>
                      <div className="mt-2 min-h-20 rounded-2xl bg-slate-50 p-3 text-sm">
                        {currentMatch ? <div className="flex items-start gap-2 text-emerald-700"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{currentMatch}</span></div> : <div className="flex items-start gap-2 text-slate-500"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>Aun no hay deteccion valida.</span></div>}
                      </div>
                    </div>

                    <div><div className="text-sm font-semibold text-slate-700">Total escaneos</div><div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{totalScans}</div></div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card className="rounded-3xl border-slate-200 shadow-sm md:col-span-2">
                  <CardContent className="p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-700">Escaneo rapido anti-falsos</div>
                      <Badge variant="secondary" className="rounded-xl px-3 py-1">{isRunning ? "Auto activo" : "Esperando camara"}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={clearHistory} variant="outline" className="rounded-2xl"><Trash2 className="mr-2 h-4 w-4" />Limpiar lista</Button>
                      <Button onClick={copySummary} variant="outline" className="rounded-2xl"><Copy className="mr-2 h-4 w-4" />Copiar resumen</Button>
                    </div>
                    <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">Primero valida que realmente haya una tarjeta (texto + banda blanca inferior + contraste). Luego clasifica pack y solo cuenta con 2-3 lecturas seguidas.</div>
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-slate-200 shadow-sm">
                  <CardContent className="p-4">
                    <div className="text-sm font-semibold text-slate-700">Debug detector</div>
                    <div className="mt-3 space-y-2 text-sm text-slate-700">
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Validez tarjeta</span><span className="font-semibold">{debugCardPresence}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Texto visible</span><span>{debugCardText}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Caja blanca</span><span>{debugCardBox}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Mejor plantilla</span><span className="font-semibold">{debugBest}</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Titulo</span><span>{debugTitle}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>N semis</span><span>{debugSemis}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Numero pack</span><span>{debugNumber}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Cuerpo</span><span>{debugBody}%</span></div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2"><span>Total</span><span className="font-semibold">{debugScore}%</span></div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="rounded-3xl border-0 shadow-xl">
              <CardHeader className="border-b bg-white"><CardTitle className="text-xl">Resumen por tipo de tarjeta</CardTitle></CardHeader>
              <CardContent className="space-y-3 p-4">
                {CARD_PATTERNS.map((card) => (
                  <div key={card.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                    <div className="text-sm font-medium text-slate-700">{card.label}</div>
                    <Badge className="rounded-xl text-sm">{totals[card.id] || 0}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-0 shadow-xl">
              <CardHeader className="border-b bg-white">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-xl">Lista de lo escaneado</CardTitle>
                  <Button size="sm" variant="ghost" onClick={() => setHistory((prev) => prev.slice(1))} className="rounded-2xl"><RotateCcw className="mr-2 h-4 w-4" />Quitar ultimo</Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[320px]">
                  <div className="divide-y">
                    {history.length === 0 ? (
                      <div className="p-5 text-sm text-slate-500">Todavia no hay lecturas validas.</div>
                    ) : (
                      history.map((item, index) => (
                        <div key={`${item.timestamp}-${index}`} className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-semibold text-slate-900">{item.label}</div>
                              <div className="mt-1 text-xs text-slate-500">{item.timestamp} - fuente: {item.source === "camera" ? "camara" : "imagen"} - score: {item.score}%</div>
                            </div>
                            <Badge variant="secondary" className="rounded-xl">#{history.length - index}</Badge>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-0 shadow-xl">
              <CardHeader className="border-b bg-white"><CardTitle className="flex items-center gap-2 text-xl"><Zap className="h-5 w-5" />Modo de deteccion</CardTitle></CardHeader>
              <CardContent className="p-4 text-sm leading-6 text-slate-700">Este modo usa comparacion visual contra tus fotos de packs. Si no coincide con plantilla, se descarta.</CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.35fr_0.95fr]">
          <Card className="overflow-hidden rounded-3xl border-0 shadow-xl">
            <CardHeader className="border-b bg-white">
              <CardTitle className="text-2xl">Entrenamiento de plantillas</CardTitle>
              <p className="mt-2 text-sm text-slate-600">Guarda fotos reales por tipo de pack para aumentar precision y reducir falsas detecciones.</p>
            </CardHeader>
            <CardContent className="space-y-4 p-4 md:p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <Card className="rounded-3xl border-slate-200 shadow-sm md:col-span-2">
                  <CardContent className="p-4">
                    <div className="relative overflow-hidden rounded-3xl bg-slate-900">
                      <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                        <div className="relative w-full max-w-md rounded-[2rem] border-4 border-cyan-300/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]">
                          <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-cyan-200/90" />
                        </div>
                      </div>
                      <div className="absolute bottom-3 left-3 right-3 rounded-2xl bg-black/55 px-4 py-3 text-sm text-white backdrop-blur-sm">{status}</div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-slate-200 shadow-sm">
                  <CardContent className="space-y-3 p-4">
                    <div className="text-sm font-semibold text-slate-700">Nuevo ejemplo</div>
                    <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Tipo de pack</label>
                    <select
                      value={selectedTrainingCardId}
                      onChange={(event) => setSelectedTrainingCardId(event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    >
                      {CARD_PATTERNS.map((card) => (
                        <option key={card.id} value={card.id}>{card.label}</option>
                      ))}
                    </select>

                    <div className="grid gap-2">
                      <Button className="rounded-2xl" onClick={captureTrainingFromCamera} disabled={!cameraReady}>
                        <Camera className="mr-2 h-4 w-4" />
                        Hacer foto de entrenamiento
                      </Button>
                      <Button variant="outline" className="rounded-2xl" onClick={() => trainingFileInputRef.current?.click()} disabled={isProcessingImage}>
                        <Upload className="mr-2 h-4 w-4" />
                        Subir foto de entrenamiento
                      </Button>
                      <input ref={trainingFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleTrainingUpload} />
                    </div>

                    <div className="rounded-2xl bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-900">
                      Haz varias fotos por pack con diferentes luces y angulos para que el detector sea mas robusto.
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card className="rounded-3xl border-slate-200 shadow-sm">
                  <CardContent className="p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-700">Muestras por tipo</div>
                    <div className="space-y-2">
                      {CARD_PATTERNS.map((card) => (
                        <div key={card.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                          <span className="text-sm text-slate-700">{card.label}</span>
                          <Badge className="rounded-xl">{trainingTotals[card.id] || 0}</Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-slate-200 shadow-sm">
                  <CardContent className="p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-700">Gestion</div>
                    <div className="grid gap-2">
                      <Button variant="outline" className="rounded-2xl" onClick={() => clearTrainingByCard(selectedTrainingCardId)} disabled={!selectedTrainingCardId}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Borrar entrenamiento del pack seleccionado
                      </Button>
                      <Button variant="outline" className="rounded-2xl" onClick={clearAllTraining} disabled={trainingSamples.length === 0}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Borrar todo el entrenamiento
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-0 shadow-xl">
            <CardHeader className="border-b bg-white"><CardTitle className="text-xl">Galeria de entrenamiento</CardTitle></CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[620px]">
                <div className="divide-y">
                  {trainingSamplesSorted.length === 0 ? (
                    <div className="p-5 text-sm text-slate-500">No hay muestras guardadas todavia.</div>
                  ) : (
                    trainingSamplesSorted.map((sample) => {
                      const card = CARD_PATTERNS.find((item) => item.id === sample.cardId);
                      return (
                        <div key={sample.id} className="flex items-center gap-3 p-4">
                          <img src={sample.dataUrl} alt={card?.label || sample.cardId} className="h-16 w-12 rounded-lg border border-slate-200 object-cover" loading="lazy" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-slate-900">{card?.label || sample.cardId}</div>
                            <div className="text-xs text-slate-500">{new Date(sample.createdAt).toLocaleString()}</div>
                          </div>
                          <Button size="sm" variant="ghost" className="rounded-xl" onClick={() => deleteTrainingSample(sample.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}

      <canvas ref={cardCanvasRef} className="hidden" />
    </div>
  );
}
