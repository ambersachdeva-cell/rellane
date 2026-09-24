/// <reference types="vite/client" />

import type { DesktopBridge } from "@cadrane/contracts";

declare global {
  interface Window {
    cadrane: DesktopBridge;
    /** Present only in the overlay document. */
    cadraneOverlay?: {
      hide(): Promise<void>;
      run(input: { kind: string; id: string; query: string }): Promise<void>;
    };
  }
}

export {};
