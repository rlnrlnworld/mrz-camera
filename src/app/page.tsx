import dynamic from "next/dynamic";

export default function Home() {
  const PassportAutoCapture = dynamic(() => import("@/components/PassportAutoCapture"), { ssr: false })

  const handleCaptured = async ({ blob, dataUrl }: { blob: Blob; dataUrl: string }) => {
    // BFF로 전송 (원하면 주석 해제)
    // const form = new FormData();
    // form.append("file", blob, "passport_roi.jpg");
    // const r = await fetch("/bff/web/mrz-extract", { method: "POST", body: form });
    // const json = await r.json();
    // console.log(json);

    console.log("captured!", blob.size, dataUrl.slice(0, 64) + "...");
  };

  return <PassportAutoCapture onCaptured={handleCaptured} debug={false} />
}
