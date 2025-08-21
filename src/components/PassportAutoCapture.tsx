"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AutoCaptureOptions = {
  consecutiveFrames?: number;
  sharpnessMin?: number;
  fillMin?: number;
  motionMax?: number;
  edgeBandFrac?: number;
  edgeRatioMin?: number;
  minSecondsBeforeCapture?: number;
};

const DEFAULT_OPTS: AutoCaptureOptions = {
  consecutiveFrames: 8,
  sharpnessMin: 35,
  fillMin: 0.12,
  motionMax: 8,
  edgeBandFrac: 0.10,
  edgeRatioMin: 0.12,
  minSecondsBeforeCapture: 1.2,
};

const GUIDE_RATIO = 0.70; // 폭:높이 ≈ 88:125 (여권 한 면 세로형)

export default function PassportAutoCapture({
  onCaptured,
  opts = DEFAULT_OPTS,
}: {
  onCaptured?: (payload: { blob: Blob; dataUrl: string }) => void;
  opts?: AutoCaptureOptions;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [readyVisual, setReadyVisual] = useState(false);
  const [whyNot, setWhyNot] = useState<string>(""); // 실패 이유 표시용(작은 글씨)

  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableCountRef = useRef(0);
  const startedAtRef = useRef<number>(0);

  // 페이지 진입 즉시 카메라 시작
  useEffect(() => {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            aspectRatio: { ideal: 16 / 9 },
          },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setError(null);
        startedAtRef.current = performance.now();
        startLoop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요."
            : "카메라를 초기화할 수 없습니다."
        );
        cleanup();
      }
    })();

    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cleanup = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    prevFrameRef.current = null;
    stableCountRef.current = 0;
    setReadyVisual(false);
  };

  // 뷰 좌표 → 비디오 좌표 매핑
  const computeRoiRect = useCallback(() => {
    const container = videoRef.current?.parentElement;
    const guide = document.getElementById("passport-guide-box");
    if (!container || !guide) return null;
    const cb = container.getBoundingClientRect();
    const gb = guide.getBoundingClientRect();
    return {
      x: gb.left - cb.left, y: gb.top - cb.top, w: gb.width, h: gb.height,
      containerW: cb.width, containerH: cb.height,
    };
  }, []);

  const guideToVideoRect = useCallback((roiInView: {
    x: number; y: number; w: number; h: number; containerW: number; containerH: number;
  }) => {
    const video = videoRef.current!;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(roiInView.containerW / vw, roiInView.containerH / vh);
    const drawnW = vw * scale, drawnH = vh * scale;
    const offsetX = (roiInView.containerW - drawnW) / 2;
    const offsetY = (roiInView.containerH - drawnH) / 2;

    const x = Math.max(0, Math.min(vw, (roiInView.x - offsetX) / scale));
    const y = Math.max(0, Math.min(vh, (roiInView.y - offsetY) / scale));
    const w = Math.max(1, Math.min(vw - x, roiInView.w / scale));
    const h = Math.max(1, Math.min(vh - y, roiInView.h / scale));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }, []);

  // 분석(밝기/초점/모션 + 테두리 에지)
  const analyzeRoi = useCallback((imgData: ImageData) => {
    const { data, width, height } = imgData;

    // gray
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    }

    // laplacian var
    let lapVar = 0, mean = 0;
    const lap = new Float32Array(width * height);
    const k = [0,1,0,1,-4,1,0,1,0];
    const idx = (x: number, y: number) => y * width + x;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const v =
          k[0]*gray[idx(x-1,y-1)] + k[1]*gray[idx(x,y-1)] + k[2]*gray[idx(x+1,y-1)] +
          k[3]*gray[idx(x-1,y)]   + k[4]*gray[idx(x,y)]   + k[5]*gray[idx(x+1,y)] +
          k[6]*gray[idx(x-1,y+1)] + k[7]*gray[idx(x,y+1)] + k[8]*gray[idx(x+1,y+1)];
        lap[idx(x,y)] = v; mean += v;
      }
    }
    const N = (width - 2) * (height - 2) || 1;
    mean /= N;
    for (let i = 0; i < lap.length; i++) { const d = lap[i] - mean; lapVar += d * d; }
    lapVar /= N;

    // 밝은 픽셀 비율
    let bright = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] > 60) bright++;
    const fillRatio = bright / gray.length;

    // sobel edge
    const sobel = new Float32Array(width * height);
    const kx = [-1,0,1,-2,0,2,-1,0,1];
    const ky = [-1,-2,-1,0,0,0,1,2,1];
    let maxMag = 1;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const gx =
          kx[0]*gray[idx(x-1,y-1)] + kx[1]*gray[idx(x,y-1)] + kx[2]*gray[idx(x+1,y-1)] +
          kx[3]*gray[idx(x-1,y)]   + kx[4]*gray[idx(x,y)]   + kx[5]*gray[idx(x+1,y)] +
          kx[6]*gray[idx(x-1,y+1)] + kx[7]*gray[idx(x,y+1)] + kx[8]*gray[idx(x+1,y+1)];
        const gy =
          ky[0]*gray[idx(x-1,y-1)] + ky[1]*gray[idx(x,y-1)] + ky[2]*gray[idx(x+1,y-1)] +
          ky[3]*gray[idx(x-1,y)]   + ky[4]*gray[idx(x,y)]   + ky[5]*gray[idx(x+1,y)] +
          ky[6]*gray[idx(x-1,y+1)] + ky[7]*gray[idx(x,y+1)] + ky[8]*gray[idx(x+1,y+1)];
        const mag = Math.abs(gx) + Math.abs(gy);
        sobel[idx(x,y)] = mag;
        if (mag > maxMag) maxMag = mag;
      }
    }

    // 테두리 밴드 에지 비율
    const band = Math.max(1, Math.round((opts.edgeBandFrac ?? DEFAULT_OPTS.edgeBandFrac!) * Math.min(width, height)));
    const thr = 0.25 * maxMag;
    const topCount = countEdge(sobel, width, height, 0, 0, width, band, thr);
    const botCount = countEdge(sobel, width, height, 0, height - band, width, band, thr);
    const leftCount = countEdge(sobel, width, height, 0, 0, band, height, thr);
    const rightCount = countEdge(sobel, width, height, width - band, 0, band, height, thr);

    const topR = topCount / (width * band);
    const botR = botCount / (width * band);
    const leftR = leftCount / (height * band);
    const rightR = rightCount / (height * band);

    return { lapVar, fillRatio, edge: { topR, botR, leftR, rightR }, gray };
  }, [opts.edgeBandFrac]);

  const countEdge = (sobel: Float32Array, w: number, h: number, sx: number, sy: number, sw: number, sh: number, thr: number) => {
    let c = 0;
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        if (sobel[y * w + x] > thr) c++;
      }
    }
    return c;
  };

  const captureAndSend = useCallback(async (roiVid: { x: number; y: number; w: number; h: number }) => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    full.getContext("2d")!.drawImage(video, 0, 0, full.width, full.height);

    const roi = document.createElement("canvas");
    roi.width = roiVid.w; roi.height = roiVid.h;
    roi.getContext("2d")!.drawImage(full, roiVid.x, roiVid.y, roiVid.w, roiVid.h, 0, 0, roiVid.w, roiVid.h);

    const dataUrl = roi.toDataURL("image/jpeg", 0.92);
    const blob = await (await fetch(dataUrl)).blob();
    onCaptured?.({ blob, dataUrl });
  }, [onCaptured]);

  // 메인 루프
  const startLoop = useCallback(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!videoRef.current) return;
      const video = videoRef.current;
      if (!video.videoWidth || !video.videoHeight) return;

      const roiInView = computeRoiRect();
      if (!roiInView) return;
      const roiVid = guideToVideoRect(roiInView);
      if (!roiVid) return;

      const ratio = roiVid.w / roiVid.h;
      const ratioOk = Math.abs(ratio - GUIDE_RATIO) <= 0.08;

      // 분석용 다운스케일
      const W = 320;
      const scale = W / roiVid.w;
      const H = Math.max(1, Math.round(roiVid.h * scale));

      if (!workCanvasRef.current) workCanvasRef.current = document.createElement("canvas");
      const wc = workCanvasRef.current;
      wc.width = W; wc.height = H;
      const wctx = wc.getContext("2d")!;
      wctx.drawImage(video, roiVid.x, roiVid.y, roiVid.w, roiVid.h, 0, 0, W, H);

      const img = wctx.getImageData(0, 0, W, H);
      const { lapVar, fillRatio, edge, gray } = analyzeRoi(img);

      // 모션
      let motion = 255;
      if (prevFrameRef.current && prevFrameRef.current.length === gray.length) {
        let sum = 0;
        for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevFrameRef.current[i]);
        motion = sum / gray.length;
      }
      prevFrameRef.current = gray;

      // 조건 체크
      const passSharp = lapVar >= (opts.sharpnessMin ?? DEFAULT_OPTS.sharpnessMin!);
      const passFill = fillRatio >= (opts.fillMin ?? DEFAULT_OPTS.fillMin!);
      const passMotion = motion <= (opts.motionMax ?? DEFAULT_OPTS.motionMax!);
      const edgeMin = (opts.edgeRatioMin ?? DEFAULT_OPTS.edgeRatioMin!);
      const passEdges = edge.topR >= edgeMin && edge.botR >= edgeMin && edge.leftR >= edgeMin && edge.rightR >= edgeMin;
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      const passTime = elapsed >= (opts.minSecondsBeforeCapture ?? DEFAULT_OPTS.minSecondsBeforeCapture!);

      const allPass = passSharp && passFill && passMotion && passEdges && ratioOk && passTime;
      setReadyVisual(allPass);

      // 실패 이유 텍스트(간단, 작은 글씨로)
      const reasons: string[] = [];
      if (!passTime) reasons.push("카메라 안정화 중…");
      if (!passSharp) reasons.push("초점 부족");
      if (!passFill) reasons.push("너무 어두움");
      if (!passMotion) reasons.push("손떨림/움직임");
      if (!passEdges) reasons.push("테두리 감지 부족");
      if (!ratioOk) reasons.push("거리/각도 불일치");
      setWhyNot(reasons.join(" · ") || "정상");

      if (allPass && !isCapturing) {
        stableCountRef.current += 1;
        if (stableCountRef.current >= (opts.consecutiveFrames ?? DEFAULT_OPTS.consecutiveFrames!)) {
          setIsCapturing(true);
          captureAndSend(roiVid).finally(() => {
            // 여러 장 연속 촬영 원하면 아래만 리셋
            setIsCapturing(false);
            stableCountRef.current = 0;
            setReadyVisual(false);
          });
        }
      } else {
        stableCountRef.current = 0;
      }
    };

    rafRef.current = requestAnimationFrame(loop);
  }, [analyzeRoi, captureAndSend, computeRoiRect, guideToVideoRect, isCapturing, opts]);

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden">
      {/* 비디오 */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* 큰 세로형 가이드: 높이 85vh 정도로 확대 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          id="passport-guide-box"
          className={`relative rounded-xl border-4 ${readyVisual ? "border-emerald-500" : "border-red-500"}`}
          style={{
            aspectRatio: `${GUIDE_RATIO} / 1`,
            height: "min(85vh, 95vw)", // 더 크게
          }}
        >
          <div className="absolute inset-0 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      {/* 상단 안내 */}
      <div className="absolute left-1/2 -translate-x-1/2 top-4 text-white/90 text-xs sm:text-sm px-3 py-1 rounded-full bg-black/50">
        여권 한 면을 가이드 안에 꽉 차게 맞춘 뒤 가만히 유지해주세요. 조건 충족 시 자동 촬영됩니다.
      </div>

      {/* 하단 작은 상태/문제 문구 */}
      <div className="absolute left-1/2 -translate-x-1/2 bottom-3 text-[11px] sm:text-xs text-white/80">
        {error ? error : readyVisual ? "좋아요! 자동 촬영 준비 완료" : whyNot}
      </div>
    </div>
  );
}