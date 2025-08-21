"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AutoCaptureOptions = {
  consecutiveFrames?: number; // 몇 프레임 연속 조건 만족 시 캡처
  sharpnessMin?: number;      // 라플라시안 분산 최소값(초점)
  fillMin?: number;           // 채움 비율 최소값(0~1) - 너무 어둡지 않은지
  motionMax?: number;         // 프레임간 평균 차이 최대값(안정도)
};

const DEFAULT_OPTS: AutoCaptureOptions = {
  consecutiveFrames: 8,
  sharpnessMin: 30,   // 기기/조명에 따라 20~80 사이 튜닝 권장
  fillMin: 0.10,      // 10% 이상 픽셀이 충분히 밝음
  motionMax: 10,      // 프레임간 평균 차이(0~255) 기준; 낮을수록 안정
};

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
  const [isCapturing, setIsCapturing] = useState(false);
  const [metrics, setMetrics] = useState<{ sharp: number; fill: number; motion: number } | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);

  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableCountRef = useRef(0);

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
        startLoop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요."
            : "카메라를 초기화할 수 없습니다."
        );
      }
    })();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const computeRoiRect = useCallback(() => {
    const container = videoRef.current?.parentElement; // 컴포넌트를 감싸는 relative 컨테이너
    const guide = document.getElementById("passport-guide-box");
    if (!container || !guide) return null;
    const cb = container.getBoundingClientRect();
    const gb = guide.getBoundingClientRect();

    return { 
      x: gb.left - cb.left,
      y: gb.top - cb.top,
      w: gb.width,
      h: gb.height,
      containerW: cb.width,
      containerH: cb.height,
    };
  }, []);

  const guideToVideoRect = useCallback((roiInView: {
    x: number; y: number; w: number; h: number; containerW: number; containerH: number;
  }) => {
    const video = videoRef.current!;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(roiInView.containerW / vw, roiInView.containerH / vh);
    const drawnW = vw * scale;
    const drawnH = vh * scale;
    const offsetX = (roiInView.containerW - drawnW) / 2;
    const offsetY = (roiInView.containerH - drawnH) / 2;

    const xInVid = (roiInView.x - offsetX) / scale;
    const yInVid = (roiInView.y - offsetY) / scale;
    const wInVid = roiInView.w / scale;
    const hInVid = roiInView.h / scale;

    const x = Math.max(0, Math.min(vw, xInVid));
    const y = Math.max(0, Math.min(vh, yInVid));
    const w = Math.max(1, Math.min(vw - x, wInVid));
    const h = Math.max(1, Math.min(vh - y, hInVid));

    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }, []);

  const analyzeRoi = useCallback((imgData: ImageData) => {
    const { data, width, height } = imgData;
    // 그레이 변환
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // BT.601 luma
      gray[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    }

    let lapVar = 0;
    let mean = 0;
    const lap = new Float32Array(width * height);
    const k = [0, 1, 0, 1, -4, 1, 0, 1, 0];
    const idx = (x: number, y: number) => y * width + x;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const v =
          k[0] * gray[idx(x - 1, y - 1)] + k[1] * gray[idx(x, y - 1)] + k[2] * gray[idx(x + 1, y - 1)] +
          k[3] * gray[idx(x - 1, y)]     + k[4] * gray[idx(x, y)]     + k[5] * gray[idx(x + 1, y)] +
          k[6] * gray[idx(x - 1, y + 1)] + k[7] * gray[idx(x, y + 1)] + k[8] * gray[idx(x + 1, y + 1)];
        lap[idx(x, y)] = v;
        mean += v;
      }
    }
    const N = (width - 2) * (height - 2);
    mean /= N || 1;
    for (let i = 0; i < lap.length; i++) {
      const d = lap[i] - mean;
      lapVar += d * d;
    }
    lapVar /= N || 1;

    // 밝은 픽셀 비율(채움 정도)
    let bright = 0;
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] > 60) bright++; // 어두운 마스크/배경과 구분용
    }
    const fillRatio = bright / gray.length;

    // 프레임간 차이(안정도)
    let motion = 255;
    if (prevFrameRef.current && prevFrameRef.current.length === gray.length) {
      let sum = 0;
      for (let i = 0; i < gray.length; i++) {
        sum += Math.abs(gray[i] - prevFrameRef.current[i]);
      }
      motion = sum / gray.length;
    }
    prevFrameRef.current = gray;

    return { sharp: lapVar, fill: fillRatio, motion };
  }, []);

  const captureAndSend = useCallback(async (roiVid: { x: number; y: number; w: number; h: number }) => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    // 원본 프레임 캔버스
    const full = document.createElement("canvas");
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    const fctx = full.getContext("2d")!;
    fctx.drawImage(video, 0, 0, full.width, full.height);

    // ROI만 자르기
    const roi = document.createElement("canvas");
    roi.width = roiVid.w;
    roi.height = roiVid.h;
    const rctx = roi.getContext("2d")!;
    rctx.drawImage(full, roiVid.x, roiVid.y, roiVid.w, roiVid.h, 0, 0, roiVid.w, roiVid.h);

    const dataUrl = roi.toDataURL("image/jpeg", 0.92);
    const blob = await (await fetch(dataUrl)).blob();

    onCaptured?.({ blob, dataUrl });

    // 예: 자동 전송 (원하면 주석 해제)
    // const form = new FormData();
    // form.append("file", blob, "passport_roi.jpg");
    // await fetch("/bff/web/mrz-extract", { method: "POST", body: form });
  }, [onCaptured]);

  const startLoop = useCallback(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      if (!videoRef.current) return;
      const video = videoRef.current;

      if (!video.videoWidth || !video.videoHeight) return;

      // 화면상의 가이드 박스 → 비디오 좌표
      const roiInView = computeRoiRect();
      if (!roiInView) return;
      const roiVid = guideToVideoRect(roiInView);
      if (!roiVid) return;

      // 분석용 다운스케일(계산량 절감)
      const W = 320; // 분석 해상도
      const scale = W / roiVid.w;
      const H = Math.max(1, Math.round(roiVid.h * scale));

      if (!workCanvasRef.current) {
        workCanvasRef.current = document.createElement("canvas");
      }
      const wc = workCanvasRef.current;
      wc.width = W;
      wc.height = H;
      const wctx = wc.getContext("2d")!;
      wctx.drawImage(
        video,
        roiVid.x, roiVid.y, roiVid.w, roiVid.h,
        0, 0, W, H
      );

      const img = wctx.getImageData(0, 0, W, H);
      const { sharp, fill, motion } = analyzeRoi(img);
      setMetrics({ sharp: Math.round(sharp), fill: +fill.toFixed(3), motion: Math.round(motion) });

      if (debug) {
        setThumb(wc.toDataURL("image/jpeg", 0.7));
      }

      // 조건 체크
      const passSharp = sharp >= (opts.sharpnessMin ?? DEFAULT_OPTS.sharpnessMin!);
      const passFill = fill >= (opts.fillMin ?? DEFAULT_OPTS.fillMin!);
      const passMotion = motion <= (opts.motionMax ?? DEFAULT_OPTS.motionMax!);

      if (passSharp && passFill && passMotion && !isCapturing) {
        stableCountRef.current += 1;
        if (stableCountRef.current >= (opts.consecutiveFrames ?? DEFAULT_OPTS.consecutiveFrames!)) {
          // 자동 캡처
          setIsCapturing(true);
          captureAndSend(roiVid).finally(() => {
            // 한 번만 캡처하고 싶으면 스트림 중지
            streamRef.current?.getTracks().forEach((t) => t.stop());
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
          });
        }
      } else {
        stableCountRef.current = 0;
      }
    };

    rafRef.current = requestAnimationFrame(loop);
  }, [analyzeRoi, captureAndSend, computeRoiRect, guideToVideoRect, debug, isCapturing, opts]);

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden">
      {/* 비디오: object-contain(좌표 매핑 정확) */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* 마스크 + 가이드 (가운데 여권 직사각형, 비율 1.42:1) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          id="passport-guide-box"
          className="relative rounded-xl border-2 border-white/90"
          style={{
            // 가이드 크기: 화면에 맞춰 자동. 최대폭 90vw, 최대높이 60vh, 비율 1.42:1
            aspectRatio: "1.42 / 1",
            width: "min(90vw, calc(60vh * 1.42))",
          }}
        >
          {/* 바깥 마스크 */}
          <div className="absolute inset-0 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      {/* 안내 텍스트 */}
      <div className="absolute left-1/2 -translate-x-1/2 top-6 text-white/90 text-sm px-3 py-1 rounded-full bg-black/50">
        여권 면을 가이드 안에 꽉 차게 맞춘 뒤 잠시 고정해주세요. 자동으로 촬영됩니다.
      </div>

      {/* 디버그 패널 */}
      {debug && (
        <div className="absolute right-3 bottom-3 bg-black/60 text-white text-xs p-2 rounded-lg space-y-2">
          {metrics && (
            <div>
              <div>sharp: {metrics.sharp}</div>
              <div>fill: {metrics.fill}</div>
              <div>motion: {metrics.motion}</div>
              <div>stable: {stableCountRef.current}</div>
            </div>
          )}
          {thumb && <img src={thumb} alt="roi" className="w-28 h-auto rounded" />}
        </div>
      )}

      {/* 오류 표기 */}
      {error && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-6 text-center text-red-200 bg-red-900/60 px-3 py-2 rounded">
          {error}
        </div>
      )}
    </div>
  );
}