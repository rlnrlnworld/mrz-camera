"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AutoCaptureOptions = {
  consecutiveFrames?: number;        // 연속 통과 프레임 수
  sharpnessMin?: number;             // 라플라시안 분산 최소
  fillMin?: number;                  // 밝기 채움 비율 최소
  motionMax?: number;                // 프레임간 차이 최대
  edgeBandFrac?: number;             // 테두리 밴드 두께 비율 (각 변 기준)
  edgeRatioMin?: number;             // 각 밴드에서 에지 픽셀 비율 최소
  minSecondsBeforeCapture?: number;  // 시작 후 최소 경과 시간
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

// 여권 한 면 세로형 비율 근사 (폭:높이)
const GUIDE_RATIO = 0.70; // ≈ 88/125

export default function PassportAutoCapture({
  onCaptured,
  debug = false,
  opts = DEFAULT_OPTS,
}: {
  onCaptured?: (payload: { blob: Blob; dataUrl: string }) => void;
  debug?: boolean;
  opts?: AutoCaptureOptions;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [readyVisual, setReadyVisual] = useState(false);
  const [metrics, setMetrics] = useState<{ sharp: number; fill: number; motion: number; top: number; bot: number; left: number; right: number } | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);

  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableCountRef = useRef(0);
  const startedAtRef = useRef<number>(0);

  // ---- 가이드 위치 계산 (뷰 → 비디오 좌표 매핑용) ----
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

    // object-contain 매핑
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

  // ---- 분석: 밝기/초점 + 에지 밴드 ----
  const analyzeRoi = useCallback((imgData: ImageData) => {
    const { data, width, height } = imgData;

    // 그레이
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    }

    // 라플라시안 분산
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

    // Sobel 엣지(대략적인 크기)
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
    const thr = 0.25 * maxMag; // 상대 임계값
    let topCount = 0, botCount = 0, leftCount = 0, rightCount = 0;
    // eslint-disable-next-line prefer-const
    let topTotal = width*band, botTotal = width*band, leftTotal = height*band, rightTotal = height*band;

    // 상단
    for (let y = 0; y < band; y++) for (let x = 0; x < width; x++) if (sobel[idx(x,y)] > thr) topCount++;
    // 하단
    for (let y = height - band; y < height; y++) for (let x = 0; x < width; x++) if (sobel[idx(x,y)] > thr) botCount++;
    // 좌측
    for (let y = 0; y < height; y++) for (let x = 0; x < band; x++) if (sobel[idx(x,y)] > thr) leftCount++;
    // 우측
    for (let y = 0; y < height; y++) for (let x = width - band; x < width; x++) if (sobel[idx(x,y)] > thr) rightCount++;

    const topR = topCount / topTotal;
    const botR = botCount / botTotal;
    const leftR = leftCount / leftTotal;
    const rightR = rightCount / rightTotal;

    return { sharp: lapVar, fill: fillRatio, edgeRatios: { topR, botR, leftR, rightR } };
  }, [opts.edgeBandFrac]);

  const captureAndSend = useCallback(async (roiVid: { x: number; y: number; w: number; h: number }) => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    const fctx = full.getContext("2d")!;
    fctx.drawImage(video, 0, 0, full.width, full.height);

    const roi = document.createElement("canvas");
    roi.width = roiVid.w; roi.height = roiVid.h;
    const rctx = roi.getContext("2d")!;
    rctx.drawImage(full, roiVid.x, roiVid.y, roiVid.w, roiVid.h, 0, 0, roiVid.w, roiVid.h);

    const dataUrl = roi.toDataURL("image/jpeg", 0.92);
    const blob = await (await fetch(dataUrl)).blob();
    onCaptured?.({ blob, dataUrl });
  }, [onCaptured]);

  // ---- 분석 루프 ----
  const startLoop = useCallback(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!active || !videoRef.current) return;
      const video = videoRef.current;
      if (!video.videoWidth || !video.videoHeight) return;

      const roiInView = computeRoiRect();
      if (!roiInView) return;
      const roiVid = guideToVideoRect(roiInView);
      if (!roiVid) return;

      // 가이드 비율에 근접한지도 체크(왜곡 방지)
      const ratio = roiVid.w / roiVid.h;
      const ratioOk = Math.abs(ratio - GUIDE_RATIO) <= 0.08; // ±0.08 허용

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
      const { sharp, fill, edgeRatios } = analyzeRoi(img);

      // 프레임간 모션
      const gray = new Uint8ClampedArray(W * H);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) gray[j] = (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) | 0;
      let motion = 255;
      if (prevFrameRef.current && prevFrameRef.current.length === gray.length) {
        let sum = 0;
        for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prevFrameRef.current[i]);
        motion = sum / gray.length;
      }
      prevFrameRef.current = gray;

      // 메트릭 노출
      setMetrics({
        sharp: Math.round(sharp),
        fill: +fill.toFixed(3),
        motion: Math.round(motion),
        top: +edgeRatios.topR.toFixed(3),
        bot: +edgeRatios.botR.toFixed(3),
        left: +edgeRatios.leftR.toFixed(3),
        right: +edgeRatios.rightR.toFixed(3),
      });
      if (debug) setThumb(wc.toDataURL("image/jpeg", 0.7));

      // 임계 비교
      const passSharp = sharp >= (opts.sharpnessMin ?? DEFAULT_OPTS.sharpnessMin!);
      const passFill = fill >= (opts.fillMin ?? DEFAULT_OPTS.fillMin!);
      const passMotion = motion <= (opts.motionMax ?? DEFAULT_OPTS.motionMax!);
      const edgeMin = (opts.edgeRatioMin ?? DEFAULT_OPTS.edgeRatioMin!);
      const passEdges = edgeRatios.topR >= edgeMin && edgeRatios.botR >= edgeMin && edgeRatios.leftR >= edgeMin && edgeRatios.rightR >= edgeMin;

      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      const passTime = elapsed >= (opts.minSecondsBeforeCapture ?? DEFAULT_OPTS.minSecondsBeforeCapture!);

      const allPass = passSharp && passFill && passMotion && passEdges && ratioOk && passTime;

      setReadyVisual(allPass); // 초록 테두리로 피드백 줄 때 사용

      if (allPass && !isCapturing) {
        stableCountRef.current += 1;
        if (stableCountRef.current >= (opts.consecutiveFrames ?? DEFAULT_OPTS.consecutiveFrames!)) {
          setIsCapturing(true);
          captureAndSend(roiVid).finally(() => {
            // 한 번만 자동 촬영하고 멈추려면 stopAll();
            // 여러 번 촬영하려면 아래 두 줄만 리셋
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
  }, [active, analyzeRoi, captureAndSend, computeRoiRect, guideToVideoRect, debug, isCapturing, opts]);

   // ---- 시작/중지 버튼 ----
  const stopAll = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    prevFrameRef.current = null;
    stableCountRef.current = 0;
    setActive(false);
    setReadyVisual(false);
  }, []);

  const startCamera = useCallback(async () => {
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
        await videoRef.current.play(); // 사용자 제스처 직후
      }
      setError(null);
      setActive(true);
      startedAtRef.current = performance.now();
      startLoop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요."
          : "카메라를 초기화할 수 없습니다."
      );
      stopAll();
    }
  }, [startLoop, stopAll]);

  useEffect(() => () => stopAll(), [stopAll]);

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden">
      {/* 프리뷰: contain(좌표 매핑 정확) */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* 중앙 세로 직사각 가이드 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          id="passport-guide-box"
          className={`relative rounded-xl border-2 ${readyVisual ? "border-emerald-400" : "border-white/90"}`}
          style={{
            // 화면에 맞게: 최대높이 75vh, 그에 맞춰 폭 = 높이 * GUIDE_RATIO
            aspectRatio: `${GUIDE_RATIO} / 1`,
            height: "min(75vh, 90vw)", // 세로 우선, 가로 폭이 부족하면 자동 축소
          }}
        >
          {/* 바깥 마스크 */}
          <div className="absolute inset-0 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      {/* 상단 안내 */}
      <div className="absolute left-1/2 -translate-x-1/2 top-6 text-white/90 text-sm px-3 py-1 rounded-full bg-black/50">
        버튼을 눌러 카메라를 켠 뒤, 여권 한 면이 가이드에 꽉 차도록 맞춰주세요. 조건 충족 시 자동 촬영됩니다.
      </div>

      {/* 하단 컨트롤 */}
      <div className="absolute left-0 right-0 bottom-4 flex items-center justify-center gap-3 px-4">
        {!active ? (
          <button onClick={startCamera} className="inline-flex items-center justify-center rounded-full px-5 py-3 bg-white text-black font-medium">
            카메라 시작
          </button>
        ) : (
          <button onClick={stopAll} className="inline-flex items-center justify-center rounded-full px-5 py-3 bg-white/90 text-black font-medium">
            카메라 중지
          </button>
        )}
      </div>

      {/* 디버그 */}
      {debug && (
        <div className="absolute right-3 bottom-3 bg-black/60 text-white text-xs p-2 rounded-lg space-y-2">
          {metrics && (
            <div>
              <div>sharp: {metrics.sharp}</div>
              <div>fill: {metrics.fill}</div>
              <div>motion: {metrics.motion}</div>
              <div>edge top: {metrics.top}</div>
              <div>edge bot: {metrics.bot}</div>
              <div>edge left: {metrics.left}</div>
              <div>edge right: {metrics.right}</div>
              <div>stable: {stableCountRef.current}</div>
            </div>
          )}
          {thumb && <img src={thumb} alt="roi" className="w-28 h-auto rounded" />}
        </div>
      )}

      {/* 오류 */}
      {error && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-6 text-center text-red-200 bg-red-900/60 px-3 py-2 rounded">
          {error}
        </div>
      )}
    </div>
  );
}