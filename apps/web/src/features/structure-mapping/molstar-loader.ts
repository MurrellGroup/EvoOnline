const MOLSTAR_VERSION = "5.11.0";
const MOLSTAR_BASE = `https://cdn.jsdelivr.net/npm/molstar@${MOLSTAR_VERSION}/build/viewer`;
const MOLSTAR_SCRIPT_INTEGRITY = "sha384-5Mfx4eL50NkWPky+mcH//qY0sbml4il0CLFFmrMp8uv/saB3Z6uZMHn2dUpAnH92";
const MOLSTAR_STYLE_INTEGRITY = "sha384-RIontCdJN53gEl2fmiHN+4bscIBvaUaOiCeeGktXqmFqdEBF+COnSdt9O4IKFSvq";

export interface MolstarViewer {
  readonly plugin: any;
  loadMvsData(data: any, format: "mvsj", options?: Readonly<Record<string, unknown>>): Promise<unknown>;
  subscribe(observable: any, action: (value: any) => void): { unsubscribe(): void };
  handleResize(): void;
  dispose(): void;
}

export interface MolstarRuntime {
  readonly Viewer: {
    create(element: HTMLElement, options: Readonly<Record<string, unknown>>): Promise<MolstarViewer>;
  };
  readonly lib: any;
}

declare global {
  interface Window {
    molstar?: MolstarRuntime;
  }
}

let loader: Promise<MolstarRuntime> | undefined;

export function loadMolstar(): Promise<MolstarRuntime> {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.reject(new Error("The structure viewer requires a browser."));
  if (window.molstar !== undefined) return Promise.resolve(window.molstar);
  if (loader !== undefined) return loader;

  loader = new Promise<MolstarRuntime>((resolve, reject) => {
    if (document.querySelector('link[data-evoonline-molstar="true"]') === null) {
      const stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = `${MOLSTAR_BASE}/molstar.css`;
      stylesheet.integrity = MOLSTAR_STYLE_INTEGRITY;
      stylesheet.crossOrigin = "anonymous";
      stylesheet.dataset.evoonlineMolstar = "true";
      document.head.append(stylesheet);
    }
    const script = document.createElement("script");
    script.src = `${MOLSTAR_BASE}/molstar.js`;
    script.async = true;
    script.integrity = MOLSTAR_SCRIPT_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.dataset.evoonlineMolstar = "true";
    script.addEventListener("load", () => {
      if (window.molstar === undefined) {
        loader = undefined;
        reject(new Error("Mol* loaded without exposing its viewer API."));
      } else resolve(window.molstar);
    }, { once: true });
    script.addEventListener("error", () => {
      loader = undefined;
      script.remove();
      reject(new Error("Mol* could not be loaded. Check this browser's network or content-security settings."));
    }, { once: true });
    document.head.append(script);
  });
  return loader;
}

export const MOLSTAR_RUNTIME_LABEL = `Mol* ${MOLSTAR_VERSION}`;
