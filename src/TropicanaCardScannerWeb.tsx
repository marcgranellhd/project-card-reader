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
  TestTube2,
} from "lucide-react";
import Tesseract from "tesseract.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

type CardPattern = {
  id: string;
  label: string;
  pack: number;
  keywords: string[];
};

type ScanHistoryItem = {
  id: string;
  label: string;
  timestamp: string;
  rawText: string;
  source: "camera" | "image";
};

type PermissionStateLike = "granted" | "denied" | "prompt" | "unsupported" | "unknown";

type CardMatch = CardPattern & { score: number };

type DetectorTest = {
  name: string;
  input: string;
  expectedId: string | null;
};

const CARD_PATTERNS: CardPattern[] = [
  { id: "tropicana-cherry-3", label: "Tropicana Cherry · Pack de 3", pack: 3, keywords: ["tropicana", "cherry", "3"] },
  { id: "tropicana-cherry-5", label: "Tropicana Cherry · Pack de 5", pack: 5, keywords: ["tropicana", "cherry", "5"] },
  { id: "tropicana-cherry-10", label: "Tropicana Cherry · Pack de 10", pack: 10, keywords: ["tropicana", "cherry", "10"] },
  { id: "tropicana-cherry-25", label: "Tropicana Cherry · Pack de 25", pack: 25, keywords: ["tropicana", "cherry", "25"] },
  { id: "tropicana-cherry-100", label: "Tropicana Cherry · Pack de 100", pack: 100, keywords: ["tropicana", "cherry", "100"] },
];

const DETECTOR_TESTS: DetectorTest[] = [
  {
    name: "Detecta pack 3 por campo semis",
    input: "Tropicana Cherry N semis 3",
    expectedId: "tropicana-cherry-3",
  },
  {
    name: "Detecta pack 5 con OCR feote",
    input: "tropicana cherrv n semis 5",
    expectedId: "tropicana-cherry-5",
  },
  {
    name: "Detecta pack 10 con semis",
    input: "TROPICANA CHERRY semis 10",
    expectedId: "tropicana-cherry-10",
  },
  {
    name: "Detecta pack 25 aunque haya ruido",
    input: "*** tropicana cherry nro semis: 25 semillas ***",
    expectedId: "tropicana-cherry-25",
  },
  {
    name: "Detecta pack 100",
    input: "Tropicana Cherry N semis 100",
    expectedId: "tropicana-cherry-100",
  },
  {
    name: "Detecta pack 100 con OCR ambiguo",
    input: "tropicana cherry n semis l00",
    expectedId: "tropicana-cherry-100",
  },
  {
    name: "Detecta pack 10 con O en vez de cero",
    input: "tropicana cherry semis 1o",
    expectedId: "tropicana-cherry-10",
  },
  {
    name: "No detecta si falta campo semis",
    input: "tropicana cherry pack 25",
    expectedId: null,
  },
  {
    name: "No detecta si no es tropicana cherry",
    input: "n semis 25 banana kush",
    expectedId: null,
  },
  {
    name: "No detecta texto irrelevante",
    input: "banana split fertilizante 500ml",
    expectedId: null,
  },
];

type OcrWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;

function normalizeCommonOcrTypos(text: string) {
  return normalizeText(text)
    .replace(/\btropieana\b/g, "tropicana")
    .replace(/\btroplcana\b/g, "tropicana")
    .replace(/\btropicana\b/g, "tropicana")
    .replace(/\bcherrv\b/g, "cherry")
    .replace(/\bchery\b/g, "cherry")
    .replace(/\bcherr\b/g, "cherry")
    .replace(/\bcherny\b/g, "cherry")
    .replace(/\bcheriy\b/g, "cherry")
    .replace(/\bsernis\b/g, "semis")
    .replace(/\bsenis\b/g, "semis")
    .replace(/\bsemi5\b/g, "semis")
    .replace(/\b5emis\b/g, "semis");
}

function normalizeAmbiguousNumbers(text: string) {
  const tokens = normalizeText(text).split(" ").filter(Boolean);

  return tokens
    .map((token) => {
      if (!/\d/.test(token)) return token;
      if (!/^[0-9oilsbzx]+$/.test(token)) return token;

      return token
        .replace(/o/g, "0")
        .replace(/[il]/g, "1")
        .replace(/s/g, "5")
        .replace(/b/g, "8")
        .replace(/z/g, "2");
    })
    .join(" ");
}

function normalizeOcrWordToken(token: string) {
  return token
    .replace(/rn/g, "m")
    .replace(/0/g, "o")
    .replace(/[1l]/g, "i")
    .replace(/5/g, "s");
}

function isSemisLikeToken(token: string) {
  const cleaned = normalizeOcrWordToken(token).replace(/[^a-z]/g, "");
  return cleaned.startsWith("semi") || cleaned.startsWith("semilla");
}

function parsePackToken(token: string): number | null {
  const normalized = normalizeAmbiguousNumbers(token).replace(/[^0-9]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  if (value === 3 || value === 5 || value === 10 || value === 25 || value === 100) return value;
  return null;
}

function enhanceImageForOCR(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    let value = (gray - 128) * 1.45 + 128;

    if (value > 170) value = 255;
    else if (value < 60) value = 0;
    else value = Math.max(0, Math.min(255, value));

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  ctx.putImageData(image, 0, 0);
}

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesTropicanaCherry(text: string) {
  const normalized = normalizeCommonOcrTypos(normalizeAmbiguousNumbers(text));
  const tokens = normalized.split(" ").map((token) => normalizeOcrWordToken(token));
  const hasTropicana = tokens.some((token) => token.includes("tropicana") || (token.startsWith("tropi") && token.endsWith("ana")));
  const hasCherry = tokens.some((token) => token.includes("cherry") || token.includes("chery") || token.includes("cherri"));
  return hasTropicana && hasCherry;
}

function parseSemisPack(text: string): number | null {
  const normalized = normalizeCommonOcrTypos(normalizeAmbiguousNumbers(text));
  if (!normalized) return null;

  const directPatterns = [
    /(?:n\s*(?:o|0|ro)?\s*)?(?:semis|semi|semilla|semillas)\s*(?:de|:)?\s*(3|5|10|25|100)\b/,
    /(?:3|5|10|25|100)\s*(?:semis|semi|semilla|semillas)\b/,
    /\bn\s*(?:o|0|ro)?\s*[:\-]?\s*(3|5|10|25|100)\b/,
  ];

  for (const pattern of directPatterns) {
    const found = normalized.match(pattern);
    if (found?.[1]) {
      const parsed = parsePackToken(found[1]);
      if (parsed) return parsed;
    }
    if (found?.[0]) {
      const num = found[0].match(/\b(3|5|10|25|100)\b/);
      if (num?.[1]) {
        const parsed = parsePackToken(num[1]);
        if (parsed) return parsed;
      }
    }
  }

  const tokens = normalized.split(" ").filter(Boolean);
  const semisIndex = tokens.findIndex((token) => isSemisLikeToken(token));
  if (semisIndex !== -1) {
    const from = Math.max(0, semisIndex - 5);
    const to = Math.min(tokens.length - 1, semisIndex + 5);
    for (let i = from; i <= to; i += 1) {
      const parsed = parsePackToken(tokens[i]);
      if (parsed) return parsed;
    }
  }

  const foundAll = tokens
    .map((token) => parsePackToken(token))
    .filter((value): value is number => value !== null);

  const hasIndexMarker = tokens.some((token) => ["n", "no", "n0", "nro", "numero"].includes(token));

  if (foundAll.length === 1 && hasIndexMarker) {
    return foundAll[0];
  }

  return null;
}

function detectCard(rawText: string): CardMatch | null {
  if (!includesTropicanaCherry(rawText)) return null;

  const pack = parseSemisPack(rawText);
  if (!pack) return null;

  const pattern = CARD_PATTERNS.find((item) => item.pack === pack);
  if (!pattern) return null;

  return {
    ...pattern,
    score: 100,
  };
}

function getReadableCameraError(error: unknown, secureContext: boolean) {
  const err = error as { name?: string; message?: string } | undefined;
  const name = err?.name || "UnknownError";

  if (!secureContext) {
    return "La cámara está bloqueada porque esta página no se está ejecutando en HTTPS o en localhost.";
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permiso de cámara denegado o bloqueado por el navegador/plataforma.";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No se ha encontrado ninguna cámara disponible en este dispositivo.";
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return "La cámara existe, pero otra app o el sistema la está usando y no deja abrirla.";
  }

  if (name === "OverconstrainedError") {
    return "La configuración de cámara solicitada no es compatible con este dispositivo.";
  }

  return `No se pudo acceder a la cámara (${name}).`;
}

async function getCameraPermissionState(): Promise<PermissionStateLike> {
  try {
    if (!("permissions" in navigator) || !navigator.permissions?.query) return "unsupported";
    const result = await navigator.permissions.query({ name: "camera" as PermissionName });
    if (result.state === "granted" || result.state === "denied" || result.state === "prompt") {
      return result.state;
    }
    return "unknown";
  } catch {
    return "unsupported";
  }
}

function formatTime() {
  return new Date().toLocaleTimeString();
}

export default function TropicanaCardScannerWeb() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const autoBootRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const isBusyRef = useRef(false);
  const lastAcceptedRef = useRef<{ id: string; at: number } | null>(null);
  const ocrWorkerRef = useRef<OcrWorker | null>(null);
  const ocrWorkerInitRef = useRef<Promise<OcrWorker> | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Inicializando cámara automática...");
  const [recognizedText, setRecognizedText] = useState("");
  const [currentMatch, setCurrentMatch] = useState<string | null>(null);
  const [intervalMs] = useState(900);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const [cameraSupported, setCameraSupported] = useState(() => Boolean(navigator.mediaDevices?.getUserMedia));
  const [secureContext, setSecureContext] = useState(() => window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const [permissionState, setPermissionState] = useState<PermissionStateLike>("unknown");
  const [lastError, setLastError] = useState<string | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [isFeedbackOn, setIsFeedbackOn] = useState(false);
  const [debugHasBrand, setDebugHasBrand] = useState(false);
  const [debugPack, setDebugPack] = useState<number | null>(null);

  const totals = useMemo(() => {
    return history.reduce<Record<string, number>>((acc, item) => {
      acc[item.id] = (acc[item.id] || 0) + 1;
      return acc;
    }, {});
  }, [history]);

  const detectorTestResults = useMemo(() => {
    return DETECTOR_TESTS.map((test) => {
      const detected = detectCard(test.input);
      const passed = (detected?.id ?? null) === test.expectedId;
      return {
        ...test,
        detectedId: detected?.id ?? null,
        passed,
      };
    });
  }, []);

  const passedTests = detectorTestResults.filter((test) => test.passed).length;
  const totalScans = history.length;

  useEffect(() => {
    setSecureContext(window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
    setCameraSupported(Boolean(navigator.mediaDevices?.getUserMedia));

    getCameraPermissionState().then(setPermissionState);

    return () => {
      if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());

      if (ocrWorkerRef.current) {
        void ocrWorkerRef.current.terminate();
        ocrWorkerRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
      ocrWorkerInitRef.current = null;
    };
  }, []);

  const playDetectionFeedback = () => {
    setIsFeedbackOn(true);
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      setIsFeedbackOn(false);
    }, 320);

    if ("vibrate" in navigator) navigator.vibrate?.(90);

    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContextRef.current) audioContextRef.current = new AudioCtx();

      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") void ctx.resume();

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(1046, ctx.currentTime);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.2);
    } catch {
      // Ignore audio errors on browsers that require explicit user gesture.
    }
  };

  const addScan = (match: { id: string; label: string }, rawText: string, source: "camera" | "image") => {
    const now = Date.now();
    const last = lastAcceptedRef.current;

    if (source === "camera" && last && last.id === match.id && now - last.at < 2500) {
      setStatus(`Detectado otra vez ${match.label}, pero se ignoró para no duplicar.`);
      return;
    }

    lastAcceptedRef.current = { id: match.id, at: now };
    setCurrentMatch(match.label);
    setStatus(`Tarjeta detectada: ${match.label}`);
    playDetectionFeedback();

    setHistory((prev) => [
      {
        id: match.id,
        label: match.label,
        timestamp: formatTime(),
        rawText,
        source,
      },
      ...prev,
    ]);
  };

  const getOcrWorker = async () => {
    if (ocrWorkerRef.current) return ocrWorkerRef.current;

    if (!ocrWorkerInitRef.current) {
      setStatus("Inicializando OCR...");
      ocrWorkerInitRef.current = (async () => {
        const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
          logger: () => {},
        });

        await worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
          preserve_interword_spaces: "1",
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789xX -",
        });

        ocrWorkerRef.current = worker;
        return worker;
      })().catch((error) => {
        ocrWorkerInitRef.current = null;
        throw error;
      });
    }

    return ocrWorkerInitRef.current as Promise<OcrWorker>;
  };

  const processDetectedText = (text: string, source: "camera" | "image", confidence?: number) => {
    const cleanText = text.trim();
    setRecognizedText(cleanText);
    setOcrConfidence(typeof confidence === "number" ? Math.round(confidence) : null);
    const hasBrand = includesTropicanaCherry(cleanText);
    const packFromSemis = parseSemisPack(cleanText);
    setDebugHasBrand(hasBrand);
    setDebugPack(packFromSemis);

    const match = detectCard(cleanText);
    if (match) {
      addScan(match, cleanText, source);
    } else {
      setCurrentMatch(null);
      if (!cleanText) {
        setStatus(source === "camera" ? "Escaneando... sin texto legible, acerca la tarjeta y mejora la luz." : "La imagen no tiene texto legible para OCR.");
      } else if (!hasBrand) {
        setStatus("Leo texto, pero no aparece “Tropicana Cherry” con claridad.");
      } else if (!packFromSemis) {
        setStatus("Veo Tropicana Cherry, pero no logro leer el número de “Nº semis”.");
      } else {
        setStatus(source === "camera" ? "Escaneando... todavía no veo una tarjeta reconocible." : "La imagen se leyó, pero no coincide con ninguna tarjeta conocida.");
      }
    }
  };

  const runOCRFromCanvas = async (source: "camera" | "image") => {
    const canvas = canvasRef.current;
    if (!canvas || isBusyRef.current) return;

    isBusyRef.current = true;
    try {
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(canvas);
      processDetectedText(data.text || "", source, data.confidence);
      setLastError(null);
    } catch (error) {
      console.error(error);
      setLastError("Hubo un error al ejecutar OCR sobre la imagen.");
      setStatus("Hubo un error al leer el texto de la tarjeta.");
    } finally {
      isBusyRef.current = false;
    }
  };

  const runOCRFromVideoFrame = async () => {
    if (!videoRef.current || !canvasRef.current || isBusyRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cropWidth = Math.round(video.videoWidth * 0.82);
    const cropHeight = Math.round(video.videoHeight * 0.62);
    const cropX = Math.round((video.videoWidth - cropWidth) / 2);
    const cropY = Math.round((video.videoHeight - cropHeight) / 2);

    const targetWidth = 1280;
    const ratio = cropHeight / cropWidth;
    canvas.width = targetWidth;
    canvas.height = Math.max(1, Math.round(targetWidth * ratio));
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    enhanceImageForOCR(ctx, canvas.width, canvas.height);

    await runOCRFromCanvas("camera");
  };

  const startScanning = () => {
    if (!cameraReady) {
      setStatus("Primero hay que iniciar la cámara.");
      return;
    }

    if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
    setIsRunning(true);
    setStatus("Escaneo activo. Enseña una tarjeta frente a la cámara.");
    void runOCRFromVideoFrame();
    scanTimerRef.current = window.setInterval(() => {
      void runOCRFromVideoFrame();
    }, Math.max(700, intervalMs));
  };

  const startCamera = async () => {
    setLastError(null);

    if (!cameraSupported) {
      setStatus("Este navegador no soporta acceso a cámara.");
      setLastError("No existe navigator.mediaDevices.getUserMedia en este entorno.");
      return;
    }

    if (!secureContext) {
      setStatus("La cámara no se puede abrir aquí porque el sitio no está en HTTPS o localhost.");
      setLastError("Contexto inseguro: la mayoría de navegadores bloquean la cámara fuera de HTTPS/localhost.");
      return;
    }

    try {
      setStatus("Solicitando acceso a la cámara...");
      const nextPermission = await getCameraPermissionState();
      setPermissionState(nextPermission);

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

      setCameraReady(true);
      setPermissionState("granted");
      setStatus("Cámara activa. Ya puedes mostrar una tarjeta.");
    } catch (error) {
      console.error(error);
      const message = getReadableCameraError(error, secureContext);
      setCameraReady(false);
      setPermissionState(await getCameraPermissionState());
      setLastError(message);
      setStatus(`${message} Si no abre, usa HTTPS/localhost o sube una imagen como plan B.`);
    }
  };

  useEffect(() => {
    if (autoBootRef.current) return;
    if (!cameraSupported || !secureContext) return;
    autoBootRef.current = true;
    void startCamera();
  }, [cameraSupported, secureContext]);

  useEffect(() => {
    if (cameraReady && !isRunning) {
      startScanning();
    }
  }, [cameraReady, isRunning, intervalMs]);

  const clearHistory = () => {
    setHistory([]);
    lastAcceptedRef.current = null;
    setCurrentMatch(null);
    setRecognizedText("");
    setOcrConfidence(null);
    setDebugHasBrand(false);
    setDebugPack(null);
    setLastError(null);
    setStatus("Lista limpiada. Puedes volver a escanear.");
  };

  const copySummary = async () => {
    const summary = history
      .map((item, index) => `${index + 1}. ${item.label} · ${item.timestamp} · fuente: ${item.source}`)
      .join("\n");

    try {
      await navigator.clipboard.writeText(summary || "Sin registros.");
      setStatus("Resumen copiado al portapapeles.");
    } catch {
      setStatus("No se pudo copiar el resumen.");
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !canvasRef.current) return;

    setIsProcessingImage(true);
    setLastError(null);
    setStatus("Procesando imagen subida...");

    try {
      const imageUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = imageUrl;

      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("No se pudo cargar la imagen."));
      });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No se pudo obtener el contexto del canvas.");

      const maxWidth = 1400;
      const scale = Math.min(1, maxWidth / image.width);
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      enhanceImageForOCR(ctx, canvas.width, canvas.height);
      await runOCRFromCanvas("image");
      URL.revokeObjectURL(imageUrl);
    } catch (error) {
      console.error(error);
      setLastError("No se pudo procesar la imagen subida.");
      setStatus("Error al procesar la imagen subida.");
    } finally {
      setIsProcessingImage(false);
      event.target.value = "";
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[1.35fr_0.95fr]">
        <Card className="overflow-hidden rounded-3xl border-0 shadow-xl">
          <CardHeader className="border-b bg-white">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-2xl">
                  <Camera className="h-6 w-6" />
                  Escáner de tarjetas · Tropicana Cherry
                </CardTitle>
                <p className="mt-2 text-sm text-slate-600">
                  La detección es automática: solo valida tarjetas que contengan "Tropicana Cherry" y lee el número del campo "Nº semis" para identificar pack 3, 5, 10, 25 o 100.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void startCamera()} disabled={cameraReady} variant="outline" className="rounded-2xl">
                  <Play className="mr-2 h-4 w-4" />
                  Reintentar cámara
                </Button>
                <Button variant="outline" className="rounded-2xl" onClick={() => fileInputRef.current?.click()} disabled={isProcessingImage}>
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
                      <div
                        className={`relative w-full max-w-md rounded-[2rem] border-4 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)] transition-all duration-200 ${
                          isFeedbackOn ? "scale-105 border-lime-300 bg-lime-200/10" : "border-emerald-400/80"
                        }`}
                      >
                        <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-emerald-300/90" />
                      </div>
                    </div>

                    {isFeedbackOn ? (
                      <div className="absolute right-3 top-3 rounded-xl bg-lime-400 px-3 py-1.5 text-xs font-bold text-slate-900">
                        DETECTADO
                      </div>
                    ) : null}

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
                  <div>
                    <div className="text-sm font-semibold text-slate-700">Entorno</div>
                    <div className="mt-3 space-y-2 text-sm text-slate-600">
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>HTTPS / localhost</span>
                        <Badge variant={secureContext ? "default" : "destructive"} className="rounded-xl">{secureContext ? "Sí" : "No"}</Badge>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>Soporte de cámara</span>
                        <Badge variant={cameraSupported ? "default" : "destructive"} className="rounded-xl">{cameraSupported ? "Sí" : "No"}</Badge>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>Permiso</span>
                        <Badge variant={permissionState === "granted" ? "default" : permissionState === "denied" ? "destructive" : "secondary"} className="rounded-xl">{permissionState}</Badge>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>Confianza OCR</span>
                        <Badge variant="secondary" className="rounded-xl">{ocrConfidence !== null ? `${ocrConfidence}%` : "--"}</Badge>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>Tropicana Cherry</span>
                        <Badge variant={debugHasBrand ? "default" : "secondary"} className="rounded-xl">{debugHasBrand ? "Sí" : "No"}</Badge>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                        <span>Pack semis detectado</span>
                        <Badge variant={debugPack ? "default" : "secondary"} className="rounded-xl">{debugPack ?? "--"}</Badge>
                      </div>
                    </div>
                  </div>

                  {lastError ? (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <div className="flex items-start gap-2 font-medium">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        Problema detectado
                      </div>
                      <div className="mt-2 leading-6">{lastError}</div>
                    </div>
                  ) : null}

                  <div>
                    <div className="text-sm font-semibold text-slate-700">Última detección</div>
                    <div className="mt-3 min-h-20 rounded-2xl bg-slate-50 p-3 text-sm">
                      {currentMatch ? (
                        <div className="flex items-start gap-2 text-emerald-700">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{currentMatch}</span>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 text-slate-500">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>Aún no hay una tarjeta detectada.</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-slate-700">Total escaneos</div>
                    <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{totalScans}</div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card className="rounded-3xl border-slate-200 shadow-sm md:col-span-2">
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">Escaneo automático</div>
                    <Badge variant="secondary" className="rounded-xl px-3 py-1">
                      {isRunning ? "Auto activo" : "Esperando cámara"}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={clearHistory} variant="outline" className="rounded-2xl">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Limpiar lista
                    </Button>
                    <Button onClick={copySummary} variant="outline" className="rounded-2xl">
                      <Copy className="mr-2 h-4 w-4" />
                      Copiar resumen
                    </Button>
                  </div>

                  <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                    No tienes que pulsar nada: en cuanto la cámara está activa, la app escanea sola y lanza aviso visual/sonoro cuando detecta una tarjeta.
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-slate-200 shadow-sm">
                <CardContent className="p-4">
                  <div className="text-sm font-semibold text-slate-700">Plan B sensato</div>
                  <div className="mt-3 rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">
                    Si el navegador bloquea la cámara, sube una foto de la tarjeta y la app intentará detectarla igual. Menos glamuroso, pero funcional: pura ingeniería de supervivencia.
                  </div>
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-3xl border-0 shadow-xl">
            <CardHeader className="border-b bg-white">
              <CardTitle className="text-xl">Resumen por tipo de tarjeta</CardTitle>
            </CardHeader>
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
                <Button size="sm" variant="ghost" onClick={() => setHistory((prev) => prev.slice(1))} className="rounded-2xl">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Quitar último
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[320px]">
                <div className="divide-y">
                  {history.length === 0 ? (
                    <div className="p-5 text-sm text-slate-500">Todavía no hay lecturas. La lista aparecerá aquí en cuanto empieces a escanear o subas una imagen.</div>
                  ) : (
                    history.map((item, index) => (
                      <div key={`${item.timestamp}-${index}`} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-semibold text-slate-900">{item.label}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {item.timestamp} · fuente: {item.source === "camera" ? "cámara" : "imagen"}
                            </div>
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
            <CardHeader className="border-b bg-white">
              <CardTitle className="text-xl">Texto leído por OCR</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700 whitespace-pre-wrap min-h-36">
                {recognizedText || "Aquí verás el texto bruto que la cámara o la imagen han conseguido leer. Si sale barro digital, toca mejorar luz, foco o diseño de tarjeta."}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-0 shadow-xl">
            <CardHeader className="border-b bg-white">
              <CardTitle className="flex items-center gap-2 text-xl">
                <TestTube2 className="h-5 w-5" />
                Pruebas del detector
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                <div className="text-sm font-medium text-slate-700">Resultado general</div>
                <Badge className="rounded-xl text-sm">{passedTests}/{detectorTestResults.length}</Badge>
              </div>
              {detectorTestResults.map((test) => (
                <div key={test.name} className="rounded-2xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800">{test.name}</div>
                    <Badge variant={test.passed ? "default" : "destructive"} className="rounded-xl">
                      {test.passed ? "OK" : "Fallo"}
                    </Badge>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-slate-500">
                    Esperado: {test.expectedId ?? "null"} · Detectado: {test.detectedId ?? "null"}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
