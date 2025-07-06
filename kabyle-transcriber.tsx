"use client";

import type React from "react";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Mic,
  Wifi,
  WifiOff,
  Settings,
  Trash2,
  Square,
  Smartphone,
  Activity,
  AlertCircle,
  CheckCircle,
  Clock,
  Volume2,
  Upload,
  File,
  FileAudio,
} from "lucide-react";

interface TranscriptionMessage {
  type: string;
  transcription?: string;
  audio_id?: string;
  timestamp?: string;
  state?: string;
  message?: string;
  code?: string;
}

interface Transcription {
  id: string;
  text: string;
  timestamp: Date;
  audioId: string;
  isLive: boolean;
  source: "recording" | "upload";
  fileName?: string;
}

interface UploadStatus {
  isUploading: boolean;
  progress: number;
  fileName: string;
  error?: string;
}

export default function KabyleTranscriber() {
  // WebSocket and connection state
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected" | "error"
  >("disconnected");
  const [connectionMessage, setConnectionMessage] = useState("");

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isPressed, setIsPressed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [audioInitialized, setAudioInitialized] = useState(false);

  // File upload state
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>({
    isUploading: false,
    progress: 0,
    fileName: "",
  });

  // Settings - Load from localStorage
  const [wsUrl, setWsUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        localStorage.getItem("kabyle-transcriber-ws-url") ||
        "ws://localhost:16391"
      );
    }
    return "ws://localhost:16391";
  });

  const [chunkDuration, setChunkDuration] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        Number(localStorage.getItem("kabyle-transcriber-chunk-duration")) || 3
      );
    }
    return 3;
  });

  const [audioQuality, setAudioQuality] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        localStorage.getItem("kabyle-transcriber-audio-quality") || "64000"
      );
    }
    return "64000";
  });

  // Transcriptions and logs
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioLevelAnimationRef = useRef<number | null>(null);
  const chunkCounterRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const touchStartTimeRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Detect mobile device
  useEffect(() => {
    const checkMobile = () => {
      const userAgent =
        navigator.userAgent || navigator.vendor || (window as any).opera;
      const isMobileDevice =
        /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
          userAgent.toLowerCase(),
        );
      setIsMobile(isMobileDevice);
      addLog(`Device detected: ${isMobileDevice ? "Mobile" : "Desktop"}`);
    };
    checkMobile();
  }, []);

  // Handle page visibility changes (mobile app backgrounding)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        addLog("App went to background");
        if (isRecording) {
          addLog("Stopping recording due to background");
          stopRecording();
        }
      } else {
        addLog("App returned to foreground");
        // Re-initialize audio context if needed
        if (
          audioContextRef.current &&
          audioContextRef.current.state === "suspended"
        ) {
          audioContextRef.current
            .resume()
            .then(() => {})
            .catch((error) => {
              addLog("Failed to resume audio context: " + error.message);
            });
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isRecording]);

  // Prevent zoom on double tap for iOS
  useEffect(() => {
    const preventZoom = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    };

    const preventDoubleTapZoom = (e: TouchEvent) => {
      const now = Date.now();
      if (now - touchStartTimeRef.current < 300) {
        e.preventDefault();
      }
      touchStartTimeRef.current = now;
    };

    document.addEventListener("touchstart", preventZoom, { passive: false });
    document.addEventListener("touchstart", preventDoubleTapZoom, {
      passive: false,
    });

    return () => {
      document.removeEventListener("touchstart", preventZoom);
      document.removeEventListener("touchstart", preventDoubleTapZoom);
    };
  }, []);

  // Save settings to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kabyle-transcriber-ws-url", wsUrl);
    }
  }, [wsUrl]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        "kabyle-transcriber-chunk-duration",
        chunkDuration.toString(),
      );
    }
  }, [chunkDuration]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kabyle-transcriber-audio-quality", audioQuality);
    }
  }, [audioQuality]);

  // Logging function
  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-49), `[${timestamp}] ${message}`]);
  }, []);

  // Handle WebSocket messages
  const handleMessage = useCallback(
    (data: TranscriptionMessage) => {
      const { type } = data;
      if (type === "state") {
        if (data.state !== "recording") {
          setConnectionMessage(data.message || "");
        }
        addLog(`State: ${data.state} - ${data.message}`);
      } else if (type === "transcription") {
        const newTranscription: Transcription = {
          id: data.audio_id || `transcription_${Date.now()}`,
          text: data.transcription || "",
          timestamp: new Date(data.timestamp || Date.now()),
          audioId: data.audio_id || "unknown",
          isLive: true,
          source: data.audio_id?.includes("upload") ? "upload" : "recording",
          fileName: data.audio_id?.includes("upload")
            ? uploadStatus.fileName
            : undefined,
        };
        setTranscriptions((prev) => [...prev.slice(-19), newTranscription]);
        addLog(`Live transcription: ${data.transcription}`);

        // Clear upload status if this was an upload
        if (data.audio_id?.includes("upload")) {
          setUploadStatus({
            isUploading: false,
            progress: 0,
            fileName: "",
          });
        }
      } else if (type === "upload_progress") {
        // Handle server-side upload progress updates
        if (data.message) {
          addLog(`Server: ${data.message}`);
        }
      } else if (type === "upload_complete") {
        // Handle upload completion confirmation from server
        addLog(
          `Server confirmed upload completion: ${data.message || "Upload processed successfully"}`,
        );
        setUploadStatus({
          isUploading: false,
          progress: 100,
          fileName: "",
        });
      } else if (type === "error") {
        addLog(`Error: ${data.message} (${data.code || "unknown"})`);
        if (!isRecording) {
          setConnectionStatus("error");
          setConnectionMessage(data.message || "Unknown error");
        }
        // Clear upload status on error
        if (uploadStatus.isUploading) {
          setUploadStatus({
            isUploading: false,
            progress: 0,
            fileName: "",
            error: data.message || "Upload failed",
          });
        }
      } else {
        addLog(`Unknown message type: ${type}`);
      }
    },
    [addLog, isRecording, uploadStatus.fileName, uploadStatus.isUploading],
  );

  // File upload handler with chunking support
  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        addLog("Cannot upload file: WebSocket not connected");
        return;
      }

      // Validate file type
      const allowedTypes = ["audio/wav", "audio/mpeg", "audio/mp3"];
      const fileExtension = file.name.toLowerCase().split(".").pop();
      const isValidExtension = ["wav", "mp3"].includes(fileExtension || "");
      const isValidMimeType = allowedTypes.includes(file.type);

      if (!isValidExtension && !isValidMimeType) {
        addLog(
          `Invalid file type: ${file.type || "unknown"}. Only .wav and .mp3 files are supported.`,
        );
        setUploadStatus({
          isUploading: false,
          progress: 0,
          fileName: "",
          error: "Invalid file type. Only .wav and .mp3 files are supported.",
        });
        return;
      }

      // Check file size (limit to 100MB for chunked upload)
      const maxSize = 100 * 1024 * 1024; // 100MB
      if (file.size > maxSize) {
        addLog(
          `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum size is 100MB.`,
        );
        setUploadStatus({
          isUploading: false,
          progress: 0,
          fileName: "",
          error: "File too large. Maximum size is 100MB.",
        });
        return;
      }

      setUploadStatus({
        isUploading: true,
        progress: 0,
        fileName: file.name,
      });

      addLog(
        `Starting chunked upload: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
      );

      try {
        // Calculate chunk size (aim for ~512KB chunks to stay well under 1MB limit)
        const CHUNK_SIZE = 512 * 1024; // 512KB
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const uploadId = `upload_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9]/g, "_")}`;

        addLog(
          `File will be split into ${totalChunks} chunks of ~${(CHUNK_SIZE / 1024).toFixed(0)}KB each`,
        );

        // Send upload start message
        const startMessage = {
          type: "upload_start",
          upload_id: uploadId,
          file_name: file.name,
          file_size: file.size,
          total_chunks: totalChunks,
          chunk_size: CHUNK_SIZE,
          timestamp: new Date().toISOString(),
        };

        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(startMessage));
          addLog(`Sent upload start message for ${totalChunks} chunks`);
        } else {
          throw new Error("WebSocket connection lost before upload start");
        }

        // Process file in chunks
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          // Check if WebSocket is still connected
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket connection lost during upload");
          }

          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);

          // Convert chunk to base64
          const chunkBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
              const result = event.target?.result as string;
              if (!result) {
                reject(new Error("Failed to read chunk data"));
                return;
              }
              const base64Data = result.split(",")[1];
              if (!base64Data) {
                reject(new Error("Invalid chunk data format"));
                return;
              }
              resolve(base64Data);
            };
            reader.onerror = () => reject(new Error("Failed to read chunk"));
            reader.readAsDataURL(chunk);
          });

          // Send chunk
          const chunkMessage = {
            type: "upload_chunk",
            upload_id: uploadId,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            chunk_data: chunkBase64,
            chunk_size: chunk.size,
            is_final_chunk: chunkIndex === totalChunks - 1,
            timestamp: new Date().toISOString(),
          };

          wsRef.current.send(JSON.stringify(chunkMessage));

          // Update progress
          const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
          setUploadStatus((prev) => ({
            ...prev,
            progress: progress,
          }));

          addLog(
            `Sent chunk ${chunkIndex + 1}/${totalChunks} (${(chunk.size / 1024).toFixed(1)}KB) - ${progress}%`,
          );

          // Small delay to prevent overwhelming the server
          if (chunkIndex < totalChunks - 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        // Send upload complete message
        const completeMessage = {
          type: "upload_complete",
          upload_id: uploadId,
          file_name: file.name,
          file_size: file.size,
          total_chunks: totalChunks,
          timestamp: new Date().toISOString(),
        };

        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(completeMessage));
          addLog(`Upload completed successfully: ${file.name}`);
        } else {
          throw new Error("WebSocket connection lost during upload completion");
        }
      } catch (error) {
        addLog("Error uploading file: " + (error as Error).message);
        setUploadStatus({
          isUploading: false,
          progress: 0,
          fileName: "",
          error: (error as Error).message,
        });

        // Send upload error message to server if still connected
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            const errorMessage = {
              type: "upload_error",
              upload_id: `upload_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9]/g, "_")}`,
              error: (error as Error).message,
              timestamp: new Date().toISOString(),
            };
            wsRef.current.send(JSON.stringify(errorMessage));
          } catch (sendError) {
            addLog(
              "Failed to send error message to server: " +
                (sendError as Error).message,
            );
          }
        }
      }
    },
    [addLog],
  );

  // Handle file input change
  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleFileUpload(file);
      }
      // Reset the input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [handleFileUpload],
  );

  // Handle drag and drop
  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (file) {
        handleFileUpload(file);
      }
    },
    [handleFileUpload],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
    },
    [],
  );

  // Initialize audio with comprehensive mobile support
  const initializeAudio = useCallback(async () => {
    try {
      // Check if page is served over HTTPS (required for most mobile browsers)
      if (
        location.protocol !== "https:" &&
        location.hostname !== "localhost" &&
        location.hostname !== "127.0.0.1"
      ) {
        addLog(
          "⚠️ WARNING: getUserMedia requires HTTPS on most mobile browsers",
        );
        addLog(`Current: ${location.protocol}//${location.hostname}`);
      }

      // Request permissions first on mobile
      if (isMobile && "permissions" in navigator) {
        try {
          const permission = await navigator.permissions.query({
            name: "microphone" as PermissionName,
          });
          addLog(`Microphone permission status: ${permission.state}`);
        } catch (permError) {
          addLog("Could not query microphone permission: " + permError);
        }
      }

      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
          ...(isMobile && {
            latency: 0,
            volume: 1.0,
          }),
        },
        video: false,
      };

      let stream;
      let apiUsed = "none";

      // Try modern API first
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          apiUsed = "modern";
        } catch (modernError) {
          addLog("❌ Modern API failed: " + (modernError as Error).message);
        }
      }

      // Try legacy APIs if modern failed or isn't available
      if (!stream) {
        const legacyMethods = [
          {
            name: "webkitGetUserMedia",
            method: (navigator as any).webkitGetUserMedia,
          },
          { name: "getUserMedia", method: (navigator as any).getUserMedia },
          {
            name: "mozGetUserMedia",
            method: (navigator as any).mozGetUserMedia,
          },
          { name: "msGetUserMedia", method: (navigator as any).msGetUserMedia },
        ];

        for (const { name, method } of legacyMethods) {
          if (method && !stream) {
            try {
              stream = await new Promise<MediaStream>((resolve, reject) => {
                method.call(
                  navigator,
                  constraints,
                  (stream: MediaStream) => {
                    resolve(stream);
                  },
                  (error: any) => {
                    addLog(
                      `❌ Legacy ${name} failed: ${error.message || error}`,
                    );
                    reject(error);
                  },
                );
              });
              apiUsed = name;
              break;
            } catch (legacyError) {
              continue;
            }
          }
        }
      }

      // If we still don't have a stream, throw an error
      if (!stream) {
        throw new Error(
          "All getUserMedia methods failed. This browser may not support microphone access or requires HTTPS.",
        );
      }

      audioStreamRef.current = stream;
      setPermissionGranted(true);

      // Log audio track settings
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        addLog(`Audio track settings: ${JSON.stringify(settings)}`);
      }

      // Setup audio context with mobile-specific handling
      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        setAudioInitialized(true);
        return true;
      }

      try {
        const audioContext = new AudioContextClass({
          sampleRate: 16000,
          latencyHint: "interactive",
        });

        // Critical: Resume audio context immediately on mobile
        if (audioContext.state === "suspended") {
          await audioContext.resume();
          addLog("Audio context resumed during initialization");
        }

        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(stream);

        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;

        microphone.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        addLog("Audio context and analyser initialized successfully");
      } catch (audioContextError) {
        addLog(
          "Audio context failed, continuing without visualization: " +
            (audioContextError as Error).message,
        );
      }

      setAudioInitialized(true);
      return true;
    } catch (error) {
      const errorMessage = (error as Error).message;

      // Show user-friendly error messages on mobile
      if (isMobile) {
        if (
          errorMessage.includes("Permission denied") ||
          errorMessage.includes("NotAllowedError")
        ) {
          alert(
            "❌ Microphone permission denied!\n\nTo fix this:\n1. Refresh the page\n2. When prompted, click 'Allow' for microphone\n3. Check your browser's site settings",
          );
        } else if (
          errorMessage.includes("NotFoundError") ||
          errorMessage.includes("DeviceNotFoundError")
        ) {
          alert(
            "❌ No microphone found!\n\nPlease check:\n1. Your device has a working microphone\n2. No other apps are using the microphone\n3. Try restarting your browser",
          );
        } else if (errorMessage.includes("NotSupportedError")) {
          alert(
            "❌ Microphone not supported!\n\nTry:\n1. Updating your browser\n2. Using Chrome, Safari, or Firefox\n3. Checking if your device supports web microphone access",
          );
        } else if (
          errorMessage.includes("HTTPS") ||
          location.protocol !== "https:"
        ) {
          alert(
            "❌ HTTPS Required!\n\nMicrophone access requires a secure connection.\n\nTry:\n1. Using https:// instead of http://\n2. Testing on localhost for development\n3. Using a secure hosting service",
          );
        } else {
          alert(
            "❌ Microphone access failed!\n\nError: " +
              errorMessage +
              "\n\nTroubleshooting:\n1. Refresh the page\n2. Try a different browser\n3. Check browser permissions\n4. Ensure microphone isn't used by another app",
          );
        }
      }

      setPermissionGranted(false);
      setAudioInitialized(false);
      console.error("Audio initialization error:", error);
      return false;
    }
  }, [addLog, isMobile]);

  // Improved audio level monitoring
  const updateAudioLevel = useCallback(() => {
    const actuallyRecording = mediaRecorderRef.current?.state === "recording";
    if (!analyserRef.current || !actuallyRecording) {
      if (audioLevelAnimationRef.current) {
        cancelAnimationFrame(audioLevelAnimationRef.current);
        audioLevelAnimationRef.current = null;
      }
      setAudioLevel(0);
      return;
    }

    try {
      const bufferLength = analyserRef.current.fftSize;
      const dataArray = new Uint8Array(bufferLength);

      // Use time domain data for better real-time response
      analyserRef.current.getByteTimeDomainData(dataArray);

      // Calculate RMS (Root Mean Square) for accurate audio level
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const sample = (dataArray[i] - 128) / 128; // Normalize to -1 to 1
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / bufferLength);
      const level = Math.min(100, rms * 100 * 5); // Amplify for better visibility

      setAudioLevel(level);
    } catch (error) {
      console.error("Audio level calculation error:", error);
      setAudioLevel(0);
    }

    // Continue animation
    audioLevelAnimationRef.current = requestAnimationFrame(updateAudioLevel);
  }, [isRecording, addLog]);

  // Send audio chunk
  const sendAudioChunk = useCallback(
    (audioBlob: Blob) => {
      const currentWs = wsRef.current;
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        addLog("Cannot send audio: WebSocket not connected");
        return;
      }

      chunkCounterRef.current++;
      const reader = new FileReader();

      reader.onload = (event) => {
        try {
          const result = event.target?.result as string;
          if (!result) {
            addLog("Error: Failed to read audio data");
            return;
          }

          const audioData = result.split(",")[1];
          if (!audioData) {
            addLog("Error: Invalid audio data format");
            return;
          }

          const message = {
            type: "audio",
            audio_data: audioData,
            format: "base64",
            audio_id: `mobile_chunk_${Date.now()}_${chunkCounterRef.current}`,
            timestamp: new Date().toISOString(),
          };

          if (currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify(message));
            addLog(
              `Sent audio chunk ${chunkCounterRef.current} (${(audioBlob.size / 1024).toFixed(1)} KB)`,
            );
          }
        } catch (error) {
          addLog("Error sending audio chunk: " + (error as Error).message);
        }
      };

      reader.onerror = (error) => {
        addLog("Error reading audio blob: " + (error as any).message);
      };

      reader.readAsDataURL(audioBlob);
    },
    [addLog],
  );

  // Start recording
  const startRecording = useCallback(async () => {
    addLog("Attempting to start recording...");

    if (!audioInitialized || !audioStreamRef.current) {
      const success = await initializeAudio();
      if (!success) {
        addLog("Failed to initialize audio");
        return;
      }
    }

    if (!audioStreamRef.current) {
      addLog("No audio stream available");
      return;
    }

    try {
      // Ensure audio context is resumed (critical for mobile)
      if (
        audioContextRef.current &&
        audioContextRef.current.state === "suspended"
      ) {
        await audioContextRef.current.resume();
      }

      // Test analyser before starting
      if (analyserRef.current) {
        const testBuffer = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(testBuffer);
        const hasData = testBuffer.some((value) => value !== 128);
      }

      let mimeType = "audio/webm;codecs=opus";
      const supportedTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/wav",
        "audio/ogg;codecs=opus",
      ];

      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          addLog(`Using MIME type: ${type}`);
          break;
        }
      }

      const options: MediaRecorderOptions = {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: Number.parseInt(audioQuality),
      };

      const mediaRecorder = new MediaRecorder(audioStreamRef.current, options);
      let audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
          addLog(`Audio chunk received: ${event.data.size} bytes`);
        }
      };

      mediaRecorder.onstop = () => {
        if (audioChunks.length > 0) {
          const audioBlob = new Blob(audioChunks, { type: mimeType });
          sendAudioChunk(audioBlob);
          audioChunks = [];
        }
      };

      mediaRecorder.onerror = (event) => {
        addLog("MediaRecorder error: " + (event as any).error?.message);
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;

      const intervalDuration = isMobile
        ? Math.max(1, chunkDuration - 0.5)
        : chunkDuration;

      chunkIntervalRef.current = setInterval(() => {
        if (mediaRecorder.state === "recording") {
          mediaRecorder.stop();
          mediaRecorder.start();
        }
      }, intervalDuration * 1000);

      setIsRecording(true);
      setRecordingTime(0);
      chunkCounterRef.current = 0;

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 0.1);
      }, 100);

      // Start audio level monitoring AFTER isRecording is set to true
      setTimeout(() => {
        updateAudioLevel();
      }, 50);

      // Also start a simple backup audio level updater that always works
      const backupLevelUpdater = setInterval(() => {
        const actuallyRecording =
          mediaRecorderRef.current?.state === "recording";
        if (!actuallyRecording) {
          return;
        }

        if (analyserRef.current) {
          try {
            const dataArray = new Uint8Array(analyserRef.current.fftSize);
            analyserRef.current.getByteTimeDomainData(dataArray);

            // Simple average calculation
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const sample = Math.abs(dataArray[i] - 128);
              sum += sample;
            }
            const average = sum / dataArray.length;
            const level = Math.min(100, (average / 128) * 100 * 3);
            setAudioLevel(level);
          } catch (error) {
            addLog("❌ Backup audio level failed: " + (error as Error).message);
          }
        } else {
          // Fallback: simulate audio level if analyser doesn't work
          const baseLevel = 20 + Math.random() * 30;
          const variation = Math.sin(Date.now() / 200) * 15;
          const randomSpike = Math.random() < 0.1 ? Math.random() * 40 : 0;
          const level = Math.max(
            0,
            Math.min(100, baseLevel + variation + randomSpike),
          );
          setAudioLevel(level);
        }
      }, 500);

      // Store the interval to clear it later
      (recordingTimerRef as any).backupLevelInterval = backupLevelUpdater;
    } catch (error) {
      addLog("Error starting recording: " + (error as Error).message);
    }
  }, [
    audioQuality,
    chunkDuration,
    initializeAudio,
    sendAudioChunk,
    updateAudioLevel,
    addLog,
    audioInitialized,
    isMobile,
    isRecording,
  ]);

  // Stop recording
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }

    if (chunkIntervalRef.current) {
      clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    // Clear backup level interval
    if ((recordingTimerRef as any).backupLevelInterval) {
      clearInterval((recordingTimerRef as any).backupLevelInterval);
      (recordingTimerRef as any).backupLevelInterval = null;
    }

    // Clear simulated level interval if it exists
    if ((recordingTimerRef as any).simulatedLevelInterval) {
      clearInterval((recordingTimerRef as any).simulatedLevelInterval);
      (recordingTimerRef as any).simulatedLevelInterval = null;
    }

    if (audioLevelAnimationRef.current) {
      cancelAnimationFrame(audioLevelAnimationRef.current);
      audioLevelAnimationRef.current = null;
    }

    setIsRecording(false);
    setRecordingTime(0);
    setAudioLevel(0);
  }, [addLog]);

  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    const currentWs = wsRef.current;
    if (currentWs?.readyState === WebSocket.OPEN) return;

    setConnectionStatus("connecting");
    setConnectionMessage("Connecting to server...");
    addLog(`Connecting to ${wsUrl}...`);

    try {
      const newWs = new WebSocket(wsUrl);
      newWs.binaryType = "arraybuffer";

      newWs.onopen = (event) => {
        setConnectionStatus("connected");
        setConnectionMessage("Connected");
        addLog("Connected to server successfully");
        setWs(newWs);
        wsRef.current = newWs;

        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        newWs.send(
          JSON.stringify({
            type: "device_info",
            is_mobile: isMobile,
            user_agent: navigator.userAgent,
            timestamp: new Date().toISOString(),
          }),
        );
      };

      newWs.onmessage = (event) => {
        try {
          const data: TranscriptionMessage = JSON.parse(event.data);
          handleMessage(data);
        } catch (e) {
          addLog("Error parsing message: " + (e as Error).message);
        }
      };

      newWs.onclose = (event) => {
        const reason = event.reason || "Unknown reason";
        const code = event.code || "Unknown code";
        setConnectionStatus("disconnected");
        setConnectionMessage(`Disconnected (${code})`);
        addLog(`Disconnected from server - Code: ${code}, Reason: ${reason}`);
        setWs(null);
        wsRef.current = null;

        if (isRecording) {
          stopRecording();
        }

        if (event.code !== 1000 && !reconnectTimeoutRef.current) {
          const reconnectDelay = isMobile ? 1000 : 3000;
          reconnectTimeoutRef.current = setTimeout(() => {
            addLog("Attempting to reconnect...");
            connectWebSocket();
          }, reconnectDelay);
        }
      };

      newWs.onerror = (error) => {
        setConnectionStatus("error");
        setConnectionMessage("Connection failed");
        addLog("WebSocket error occurred");
      };
    } catch (error) {
      setConnectionStatus("error");
      setConnectionMessage("Failed to create connection");
      addLog("Error creating WebSocket: " + (error as Error).message);
    }
  }, [addLog, handleMessage, isRecording, stopRecording, wsUrl, isMobile]);

  useEffect(() => {
    addLog("Auto-connecting to server on page load...");
    connectWebSocket();
  }, [connectWebSocket]);

  // Touch handlers
  const handlePressStart = useCallback(
    async (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (connectionStatus !== "connected" || isRecording) return;

      if (isMobile && "vibrate" in navigator) {
        navigator.vibrate(50);
      }

      setIsPressed(true);

      if (
        audioContextRef.current &&
        audioContextRef.current.state === "suspended"
      ) {
        try {
          await audioContextRef.current.resume();
        } catch (error) {
          addLog("Failed to resume audio context: " + (error as Error).message);
        }
      }

      await startRecording();
    },
    [connectionStatus, isRecording, startRecording, addLog, isMobile],
  );

  const handlePressEnd = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsPressed(false);

      if (isRecording) {
        stopRecording();
      }

      if (isMobile && "vibrate" in navigator) {
        navigator.vibrate(25);
      }
    },
    [isRecording, stopRecording, addLog, isMobile],
  );

  // Clear functions
  const clearTranscriptions = useCallback(() => {
    setTranscriptions([]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Format time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Disconnect
  const disconnectWebSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const currentWs = wsRef.current;
    if (currentWs) {
      currentWs.close(1000, "Manual disconnect");
      setWs(null);
      wsRef.current = null;
    }

    if (isRecording) {
      stopRecording();
    }

    setConnectionStatus("disconnected");
    setConnectionMessage("Manually disconnected");
    addLog("Manually disconnected from server");
  }, [isRecording, stopRecording, addLog]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      const currentWs = wsRef.current;
      if (currentWs) {
        currentWs.close(1000, "Component unmounting");
      }

      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close();
      }

      if (chunkIntervalRef.current) {
        clearInterval(chunkIntervalRef.current);
      }

      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }

      // Clear backup level interval
      if ((recordingTimerRef as any).backupLevelInterval) {
        clearInterval((recordingTimerRef as any).backupLevelInterval);
      }

      // Clear simulated level interval
      if ((recordingTimerRef as any).simulatedLevelInterval) {
        clearInterval((recordingTimerRef as any).simulatedLevelInterval);
      }

      if (audioLevelAnimationRef.current) {
        cancelAnimationFrame(audioLevelAnimationRef.current);
      }
    };
  }, []);

  const getConnectionStatusIcon = () => {
    switch (connectionStatus) {
      case "connected":
        return <Wifi className="h-4 w-4" />;
      case "connecting":
        return <Activity className="h-4 w-4 animate-pulse" />;
      case "error":
        return <AlertCircle className="h-4 w-4" />;
      default:
        return <WifiOff className="h-4 w-4" />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3">
            <Mic className="h-8 w-8 text-blue-500" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-100">
              Kabyle Transcriber
            </h1>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge variant="default" className="flex items-center gap-1">
              {getConnectionStatusIcon()}
              {connectionStatus === "connected"
                ? "Connected"
                : connectionStatus === "connecting"
                  ? "Connecting"
                  : connectionStatus === "error"
                    ? "Error"
                    : "Disconnected"}
            </Badge>
            {isMobile && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Smartphone className="h-3 w-3" />
                Mobile
              </Badge>
            )}
            {connectionMessage && (
              <p className="text-sm text-slate-400">{connectionMessage}</p>
            )}
          </div>
        </div>

        {/* Main Content */}
        <Tabs defaultValue="main" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="main" className="flex items-center gap-2">
              <Mic className="h-4 w-4" />
              Main
            </TabsTrigger>
            <TabsTrigger value="settings" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="space-y-6">
            {/* Recording Controls */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-center text-slate-100">
                  Push to Talk
                </CardTitle>
                <CardDescription className="text-center text-slate-400">
                  {connectionStatus === "connected"
                    ? isMobile
                      ? "Tap and hold the microphone button to record"
                      : "Hold the microphone button to record"
                    : "Connect to server to start recording"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex justify-center">
                  <Button
                    size="lg"
                    variant={
                      isRecording || isPressed ? "destructive" : "default"
                    }
                    className={`h-24 w-24 md:h-32 md:w-32 rounded-full transition-all duration-200 ${
                      isRecording || isPressed
                        ? "scale-105 shadow-lg shadow-red-500/25"
                        : "hover:scale-105 bg-blue-600 hover:bg-blue-700"
                    } ${connectionStatus !== "connected" ? "opacity-50" : ""}`}
                    disabled={connectionStatus !== "connected"}
                    onMouseDown={handlePressStart}
                    onMouseUp={handlePressEnd}
                    onMouseLeave={handlePressEnd}
                    onTouchStart={handlePressStart}
                    onTouchEnd={handlePressEnd}
                    onTouchCancel={handlePressEnd}
                  >
                    {isRecording ? (
                      <Square className="h-8 w-8 md:h-12 md:w-12" />
                    ) : (
                      <Mic className="h-8 w-8 md:h-12 md:w-12" />
                    )}
                  </Button>
                </div>

                {!permissionGranted && !audioInitialized && (
                  <div className="text-center">
                    <Button
                      onClick={(e) => {
                        e.preventDefault();
                        initializeAudio();
                      }}
                      className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Grant Microphone Permission
                    </Button>
                  </div>
                )}

                {isRecording && (
                  <div className="space-y-4">
                    <div className="text-center">
                      <div className="text-2xl md:text-3xl font-mono font-bold text-red-500">
                        {formatTime(recordingTime)}
                      </div>
                      <p className="text-sm text-slate-400">Recording time</p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-center gap-2">
                        <Volume2 className="h-4 w-4 text-slate-400" />
                        <span className="text-sm text-slate-400">
                          Audio Level
                        </span>
                      </div>
                      <Progress
                        value={Math.min(100, audioLevel)}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* File Upload Section */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-center text-slate-100 flex items-center justify-center gap-2">
                  <Upload className="h-5 w-5" />
                  Upload Audio File
                </CardTitle>
                <CardDescription className="text-center text-slate-400">
                  Upload .wav or .mp3 files for transcription
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    connectionStatus === "connected"
                      ? "border-slate-600 hover:border-slate-500 hover:bg-slate-700/50"
                      : "border-slate-700 opacity-50"
                  }`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".wav,.mp3,audio/wav,audio/mpeg,audio/mp3"
                    onChange={handleFileInputChange}
                    className="hidden"
                    disabled={
                      connectionStatus !== "connected" ||
                      uploadStatus.isUploading
                    }
                  />

                  {uploadStatus.isUploading ? (
                    <div className="space-y-4">
                      <FileAudio className="h-12 w-12 mx-auto text-blue-500 animate-pulse" />
                      <div>
                        <p className="text-slate-200 font-medium">
                          Uploading {uploadStatus.fileName}...
                        </p>
                        <Progress
                          value={uploadStatus.progress}
                          className="mt-2"
                        />
                        <p className="text-sm text-slate-400 mt-1">
                          {uploadStatus.progress}% complete
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <FileAudio className="h-12 w-12 mx-auto text-slate-400" />
                      <div>
                        <p className="text-slate-200 font-medium">
                          Drop audio files here or click to browse
                        </p>
                        <p className="text-sm text-slate-400 mt-1">
                          Supports .wav and .mp3 files up to 100MB
                        </p>
                      </div>
                      <Button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={connectionStatus !== "connected"}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Choose File
                      </Button>
                    </div>
                  )}
                </div>

                {uploadStatus.error && (
                  <Alert className="bg-red-900/20 border-red-800">
                    <AlertCircle className="h-4 w-4 text-red-500" />
                    <AlertDescription className="text-red-200">
                      {uploadStatus.error}
                    </AlertDescription>
                  </Alert>
                )}

                {connectionStatus !== "connected" && (
                  <Alert className="bg-yellow-900/20 border-yellow-800">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <AlertDescription className="text-yellow-200">
                      Connect to server to upload files
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* Transcriptions */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-slate-100">Transcriptions</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearTranscriptions}
                  className="flex items-center gap-1 border-slate-600 text-slate-300 hover:bg-slate-700 bg-transparent"
                >
                  <Trash2 className="h-4 w-4" />
                  {!isMobile && "Clear"}
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-64 md:h-96 w-full">
                  {transcriptions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center text-slate-400">
                      <Mic className="h-12 w-12 mb-4 opacity-50" />
                      <p>No transcriptions yet.</p>
                      <p className="text-sm">
                        Upload an audio file or{" "}
                        {isMobile ? "tap and hold" : "hold"} the microphone
                        button to record.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {transcriptions.map((transcription) => (
                        <div
                          key={transcription.id}
                          className={`p-4 rounded-lg border-l-4 bg-slate-700/50 ${
                            transcription.source === "upload"
                              ? "border-l-green-500"
                              : transcription.isLive
                                ? "border-l-yellow-500"
                                : "border-l-blue-500"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={
                                  transcription.source === "upload"
                                    ? "default"
                                    : transcription.isLive
                                      ? "destructive"
                                      : "default"
                                }
                                className="text-xs"
                              >
                                {transcription.source === "upload" ? (
                                  <>
                                    <File className="h-3 w-3 mr-1" />
                                    Upload
                                  </>
                                ) : transcription.isLive ? (
                                  <>
                                    <Activity className="h-3 w-3 mr-1" />
                                    Live
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle className="h-3 w-3 mr-1" />
                                    Final
                                  </>
                                )}
                              </Badge>
                              {transcription.fileName && (
                                <Badge variant="outline" className="text-xs">
                                  {transcription.fileName}
                                </Badge>
                              )}
                            </div>
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {transcription.timestamp.toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm md:text-base leading-relaxed text-slate-200">
                            {transcription.text || (
                              <em className="text-slate-400">
                                No transcription
                              </em>
                            )}
                          </p>
                          <div className="text-xs text-slate-500 mt-2 truncate">
                            Audio ID: {transcription.audioId}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="space-y-6">
            {/* Connection Settings */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-slate-100">
                  Connection Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ws-url" className="text-slate-200">
                    WebSocket URL
                  </Label>
                  <Input
                    id="ws-url"
                    type="text"
                    value={wsUrl}
                    onChange={(e) => setWsUrl(e.target.value)}
                    placeholder="ws://localhost:16391"
                    disabled={connectionStatus === "connecting"}
                    className="bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-400"
                  />
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  {connectionStatus === "connected" ? (
                    <Button
                      onClick={disconnectWebSocket}
                      variant="destructive"
                      className="flex-1"
                    >
                      <WifiOff className="h-4 w-4 mr-2" />
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      onClick={connectWebSocket}
                      disabled={connectionStatus === "connecting"}
                      className="flex-1 bg-blue-600 hover:bg-blue-700"
                    >
                      <Wifi className="h-4 w-4 mr-2" />
                      {connectionStatus === "connecting"
                        ? "Connecting..."
                        : "Connect"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      const currentWs = wsRef.current;
                      if (
                        currentWs &&
                        currentWs.readyState === WebSocket.OPEN
                      ) {
                        currentWs.send(
                          JSON.stringify({
                            type: "ping",
                            timestamp: new Date().toISOString(),
                          }),
                        );
                        addLog("Ping sent to server");
                      } else {
                        addLog("Cannot ping: not connected to server");
                      }
                    }}
                    disabled={connectionStatus !== "connected"}
                    className="border-slate-600 text-slate-300 hover:bg-slate-700"
                  >
                    <Activity className="h-4 w-4 mr-2" />
                    Ping
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Audio Settings */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-slate-100">Audio Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="chunk-duration" className="text-slate-200">
                      Chunk Duration (seconds)
                    </Label>
                    <Input
                      id="chunk-duration"
                      type="number"
                      min="1"
                      max="10"
                      value={chunkDuration}
                      onChange={(e) =>
                        setChunkDuration(Number.parseInt(e.target.value))
                      }
                      className="bg-slate-700 border-slate-600 text-slate-100"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="audio-quality" className="text-slate-200">
                      Audio Quality
                    </Label>
                    <Select
                      value={audioQuality}
                      onValueChange={setAudioQuality}
                    >
                      <SelectTrigger
                        id="audio-quality"
                        className="bg-slate-700 border-slate-600 text-slate-100"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem
                          value="96000"
                          className="text-slate-100 focus:bg-slate-700"
                        >
                          High (96 kbps)
                        </SelectItem>
                        <SelectItem
                          value="64000"
                          className="text-slate-100 focus:bg-slate-700"
                        >
                          Medium (64 kbps)
                        </SelectItem>
                        <SelectItem
                          value="32000"
                          className="text-slate-100 focus:bg-slate-700"
                        >
                          Low (32 kbps)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Mobile-specific audio info */}
                {isMobile && (
                  <Alert className="bg-slate-700 border-slate-600">
                    <Smartphone className="h-4 w-4 text-blue-500" />
                    <AlertDescription className="text-slate-200">
                      <div className="space-y-1">
                        <div className="font-medium">Mobile Audio Status</div>
                        <div className="text-sm space-y-1">
                          <div>
                            Permission granted:{" "}
                            {permissionGranted ? "✅" : "❌"}
                          </div>
                          <div>
                            Audio initialized: {audioInitialized ? "✅" : "❌"}
                          </div>
                          <div>
                            Audio context state:{" "}
                            {audioContextRef.current?.state || "Not created"}
                          </div>
                        </div>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* System Logs */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-slate-100">System Logs</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearLogs}
                  className="flex items-center gap-1 border-slate-600 text-slate-300 hover:bg-slate-700 bg-transparent"
                >
                  <Trash2 className="h-4 w-4" />
                  {!isMobile && "Clear"}
                </Button>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-48 md:h-64 w-full">
                  <div className="font-mono text-xs space-y-1 p-3 bg-slate-900 rounded-md border border-slate-700">
                    {logs.length === 0 ? (
                      <div className="text-slate-500">No logs yet...</div>
                    ) : (
                      logs.map((log, index) => (
                        <div key={index} className="text-slate-300 break-words">
                          {log}
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
