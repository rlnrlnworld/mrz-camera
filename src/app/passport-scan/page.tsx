"use client"

import { usePassportStore } from "@/store/usePassportStore";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

export default function PassportScan() {
  const router = useRouter();
  const setImageUrl = usePassportStore((s) => s.setImageUrl);
  const PassportAutoCapture = dynamic(() => import("@/components/PassportAutoCapture"), { ssr: false });

  const handleCaptured = async ({ blob }: { blob: Blob; dataUrl: string }) => {
    const objectUrl = URL.createObjectURL(blob);
    setImageUrl(objectUrl);
    router.push("/passport-result");
  };

  return <PassportAutoCapture onCaptured={handleCaptured} />;
}