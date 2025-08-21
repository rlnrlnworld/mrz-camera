"use client"

import { useRouter } from "next/navigation"

export default function Home() {
  const router = useRouter()

  return (
    <main className="h-screen w-full flex flex-col items-center justify-center">
      <button onClick={() => router.push("/passport-scan")} className="bg-white border border-neutral-200 rounded px-2 py-1">
        카메라 실행
      </button>
    </main>
  )
}
