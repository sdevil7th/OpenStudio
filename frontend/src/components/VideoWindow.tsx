import { useEffect, useRef, useCallback } from "react";
import { X, FolderOpen } from "lucide-react";
import { useDAWStore } from "../store/useDAWStore";
import { nativeBridge } from "../services/NativeBridge";
import { Button } from "./ui";

export function VideoWindow() {
  const showVideoWindow = useDAWStore((s) => s.showVideoWindow);
  const videoInfo = useDAWStore((s) => s.videoInfo);
  const videoFilePath = useDAWStore((s) => s.videoFilePath);
  const isPlaying = useDAWStore((s) => s.transport.isPlaying);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRequestRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(-1);

  const drawFrame = useCallback(async (time: number) => {
    if (!canvasRef.current || !videoInfo) return;
    // Avoid re-fetching same frame
    const frameIndex = Math.floor(time * (videoInfo.fps || 30));
    if (frameIndex === lastFrameTimeRef.current) return;
    lastFrameTimeRef.current = frameIndex;

    try {
      const base64 = await nativeBridge.getVideoFrame(time);
      const img = new Image();
      img.onload = () => {
        const ctx = canvasRef.current?.getContext("2d");
        if (ctx && canvasRef.current) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.drawImage(img, 0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      };
      img.src = base64;
    } catch {
      // Frame decode failed, skip
    }
  }, [videoInfo]);

  // Playback frame loop
  useEffect(() => {
    if (!isPlaying || !videoInfo || !showVideoWindow) return;

    const loop = () => {
      const currentTime = useDAWStore.getState().transport.currentTime;
      drawFrame(currentTime);
      frameRequestRef.current = requestAnimationFrame(loop);
    };
    frameRequestRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRequestRef.current);
  }, [isPlaying, videoInfo, showVideoWindow, drawFrame]);

  // Seek: draw single frame when not playing
  useEffect(() => {
    if (isPlaying || !videoInfo || !showVideoWindow) return;
    const unsub = useDAWStore.subscribe(
      (s) => s.transport.currentTime,
      (time) => { drawFrame(time); },
    );
    return unsub;
  }, [isPlaying, videoInfo, showVideoWindow, drawFrame]);

  const handleOpenVideo = async () => {
    const filePath = await nativeBridge.showOpenDialog("Open Video File");
    if (filePath) {
      useDAWStore.getState().openVideoFile(filePath);
    }
  };

  if (!showVideoWindow) return null;

  const aspectRatio = videoInfo ? videoInfo.width / videoInfo.height : 16 / 9;
  const displayWidth = 480;
  const displayHeight = Math.round(displayWidth / aspectRatio);

  return (
    <div className="fixed right-4 top-16 z-1000 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl overflow-hidden"
      style={{ width: displayWidth }}
    >
      {/* Header */}
      <div className="h-6 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between px-2">
        <span className="text-[9px] font-semibold text-neutral-400 uppercase tracking-wider">
          Video {videoInfo ? `(${videoInfo.width}x${videoInfo.height})` : ""}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={handleOpenVideo} title="Open Video">
            <FolderOpen size={11} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => useDAWStore.getState().toggleVideoWindow()} title="Close">
            <X size={12} />
          </Button>
        </div>
      </div>

      {/* Canvas */}
      {videoInfo ? (
        <canvas
          ref={canvasRef}
          width={videoInfo.width}
          height={videoInfo.height}
          className="w-full bg-black"
          style={{ height: displayHeight }}
        />
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-2 bg-black cursor-pointer"
          style={{ height: displayHeight }}
          onClick={handleOpenVideo}
        >
          <FolderOpen size={24} className="text-neutral-600" />
          <span className="text-[10px] text-neutral-500">Click to open a video file</span>
        </div>
      )}

      {/* Info bar */}
      <div className="h-4 bg-neutral-800 border-t border-neutral-700 flex items-center justify-between px-2">
        <span className="text-[8px] text-neutral-500 truncate">
          {videoFilePath ? videoFilePath.split(/[/\\]/).pop() : "No video loaded"}
        </span>
        {videoInfo && (
          <span className="text-[8px] text-neutral-500">
            {videoInfo.fps}fps
          </span>
        )}
      </div>
    </div>
  );
}
