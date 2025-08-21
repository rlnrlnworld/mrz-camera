import { create } from "zustand";

type PassportState = {
  imageUrl: string | null;
  setImageUrl: (url: string) => void;
};

export const usePassportStore = create<PassportState>((set) => ({
  imageUrl: null,
  setImageUrl: (url) => set({ imageUrl: url }),
}));