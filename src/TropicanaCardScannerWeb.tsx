import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  ScanLine,
  Trash2,
  Play,
  Square,
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
import { Input } from "@/components/ui/input";
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
    name: "Detecta pack 3 con texto limpio",
    input: "Tropicana Cherry Pack de 3",
    expectedId: "tropicana-cherry-3",
  },
  {
    name: "Detecta pack 5 con OCR feote",
    input: "tropicana cherrv de 5",
    expectedId: "tropicana-cherry-5",
  },
  {
    name: "Detecta pack 10 con x10",
    input: "TROPICANA CHERRY x10",
    expectedId: "tropicana-cherry-10",
  },
  {
    name: "Detecta pack 25 aunque haya ruido",
    input: "*** tropicana cherry pack 25 semillas ***",
    expectedId: "tropicana-cherry-25",
  },
  {
    name: "Detecta pack 100",
    input: "Tropicana Cherry 100",
    expectedId: "tropicana-cherry-100",
  },
  {
    name: "Detecta pack 100 con OCR ambiguo",
    input: "tropicana cherry l00",
    expectedId: "tropicana-cherry-100",
  },
  {
    name: "Detecta pack 10 con O en vez de cero",
    input: "tropicana cherry x1o",
    expectedId: "tropicana-cherry-10",
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
    .replace(/\bcherrv\b/g, "cherry")
    .replace(/\bchery\b/g, "cherry")
    .replace(/\btropicana\b/g, "tropicana")
    .replace(/\btropieana\b/g, "tropicana");
}

function normalizeAmbiguousNumbers(text: string) {
  const tokens = normalizeText(text).split(" ").filter(Boolean);

  return tokens
    .map((token) => {
      if (!/[a-z]/.test(token) || !/\d/.test(token)) return token;

      return token
        .replace(/o/g, "0")
        .replace(/[il]/g, "1")
        .replace(/s/g, "5")
        .replace(/b/g, "8")
        .replace(/z/g, "2");
    })
    .join(" ");
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

function scoreMatch(text: string, pattern: CardPattern) {
  let score = 0;
  const normalized = normalizeText(text);

  if (!normalized) return 0;

  if (normalized.includes("tropicana")) score += 2;
  if (normalized.includes("cherry") || normalized.includes("cherrv") || normalized.includes("chery")) score += 2;

  for (const keyword of pattern.keywords) {
    if (normalized.includes(String(keyword))) score += 3;
  }

  const packRegex = new RegExp(`(?:pack|pak|paq|x)?\\s*${pattern.pack}(?!\\d)`);
  if (packRegex.test(normalized)) score += 6;

  if (normalized.includes(`de ${pattern.pack}`)) score += 4;
  if (normalized.includes(`pack de ${pattern.pack}`)) score += 5;
  if (normalized.includes(`x${pattern.pack}`)) score += 5;

  return score;
}

function detectCard(rawText: string): CardMatch | null {
  const base = normalizeText(rawText);
  if (!base) return null;

  const variants = [
    base,
    normalizeCommonOcrTypos(rawText),
    normalizeAmbiguousNumbers(rawText),
    normalizeCommonOcrTypos(normalizeAmbiguousNumbers(rawText)),
  ];

  const uniqueVariants = [...new Set(variants.filter(Boolean))];

  let best: CardMatch | null = null;
  for (const variant of uniqueVariants) {
    const ranked: CardMatch[] = CARD_PATTERNS.map((pattern) => ({
      ...pattern,
      score: scoreMatch(variant, pattern),
    })).sort((a, b) => b.score - a.score);

    if (!ranked[0]) continue;
    if (!best || ranked[0].score > best.score) best = ranked[0];
  }

  if (!best || best.score < 7) return null;
  return best;
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
  const isBusyRef = useRef(false);
  const lastAcceptedRef = useRef<{ id: string; at: number } | null>(null);
  const ocrWorkerRef = useRef<OcrWorker | null>(null);
  const ocrWorkerInitRef = useRef<Promise<OcrWorker> | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Pulsa “Iniciar cámara” para empezar.");
  const [recognizedText, setRecognizedText] = useState("");
  const [currentMatch, setCurrentMatch] = useState<string | null>(null);
  const [intervalMs, setIntervalMs] = useState(1200);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);
  const [cameraSupported, setCameraSupported] = useState(true);
  const [secureContext, setSecureContext] = useState(true);
  const [permissionState, setPermissionState] = useState<PermissionStateLike>("unknown");
  const [lastError, setLastError] = useState<string | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);

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
      streamRef.current?.getTracks().forEach((track) => track.stop());

      if (ocrWorkerRef.current) {
        void ocrWorkerRef.current.terminate();
        ocrWorkerRef.current = null;
      }
      ocrWorkerInitRef.current = null;
    };
  }, []);

  const stopScanning = () => {
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setIsRunning(false);
    setStatus("Escaneo pausado.");
  };

  const stopCamera = () => {
    stopScanning();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
    setOcrConfidence(null);
    setStatus("Cámara detenida.");
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

    const match = detectCard(cleanText);
    if (match) {
      addScan(match, cleanText, source);
    } else {
      setCurrentMatch(null);
      if (!cleanText) {
        setStatus(source === "camera" ? "Escaneando... sin texto legible, acerca la tarjeta y mejora la luz." : "La imagen no tiene texto legible para OCR.");
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
      setStatus(`${message} Usa HTTPS/localhost o el botón de subir imagen como plan B.`);
    }
  };

  const clearHistory = () => {
    setHistory([]);
    lastAcceptedRef.current = null;
    setCurrentMatch(null);
    setRecognizedText("");
    setOcrConfidence(null);
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
                  Muestra una tarjeta a cámara y la app leerá el texto para detectar si es pack de 3, 5, 10, 25 o 100. Si la cámara falla, puedes subir una foto como alternativa.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={startCamera} disabled={cameraReady} className="rounded-2xl">
                  <Play className="mr-2 h-4 w-4" />
                  Iniciar cámara
                </Button>
                <Button onClick={stopCamera} variant="outline" className="rounded-2xl">
                  <Square className="mr-2 h-4 w-4" />
                  Detener cámara
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
                      <div className="relative w-full max-w-md rounded-[2rem] border-4 border-emerald-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]">
                        <div className="absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2 bg-emerald-300/90" />
                      </div>
                    </div>

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
                    <div className="text-sm font-semibold text-slate-700">Controles de escaneo</div>
                    <Badge variant="secondary" className="rounded-xl px-3 py-1">
                      {isRunning ? "Activo" : "Pausado"}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={startScanning} disabled={!cameraReady || isRunning} className="rounded-2xl">
                      <Play className="mr-2 h-4 w-4" />
                      Empezar a escanear
                    </Button>
                    <Button onClick={stopScanning} variant="outline" disabled={!isRunning} className="rounded-2xl">
                      <Square className="mr-2 h-4 w-4" />
                      Pausar
                    </Button>
                    <Button onClick={clearHistory} variant="outline" className="rounded-2xl">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Limpiar lista
                    </Button>
                    <Button onClick={copySummary} variant="outline" className="rounded-2xl">
                      <Copy className="mr-2 h-4 w-4" />
                      Copiar resumen
                    </Button>
                  </div>

                  <div className="mt-4 flex items-center gap-3">
                    <label className="text-sm text-slate-600">Intervalo de lectura (ms)</label>
                    <Input
                      type="number"
                      min={700}
                      step={100}
                      value={intervalMs}
                      onChange={(e) => setIntervalMs(Number(e.target.value || 1200))}
                      className="max-w-32 rounded-2xl"
                    />
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
