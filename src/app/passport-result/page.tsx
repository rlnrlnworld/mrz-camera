"use client"

import { usePassportStore } from "@/store/usePassportStore";

export default function PassportResultPage() {
  const imageUrl = usePassportStore((s) => s.imageUrl);

  return (
    <div className="flex flex-col items-center">
      <h1>촬영 결과</h1>
      {imageUrl && <img src={imageUrl} alt="Captured passport" className="max-w-full" />}
    </div>
  );
}