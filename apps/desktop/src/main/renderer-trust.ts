export const DEVELOPMENT_RENDERER_URL = "http://127.0.0.1:5173";
export const APPLICATION_RENDERER_URL = "switchboard://app/index.html";

export interface RendererTarget {
  development: boolean;
  url: string;
}

export function resolveRendererTarget(
  isPackaged: boolean,
  configuredDevelopmentUrl: string | undefined
): RendererTarget {
  const development = !isPackaged && configuredDevelopmentUrl === DEVELOPMENT_RENDERER_URL;
  return {
    development,
    url: development ? DEVELOPMENT_RENDERER_URL : APPLICATION_RENDERER_URL
  };
}

export function isTrustedRendererUrl(rawUrl: string, target: RendererTarget): boolean {
  try {
    const url = new URL(rawUrl);
    if (target.development) {
      return url.origin === DEVELOPMENT_RENDERER_URL;
    }
    return url.protocol === "switchboard:" && url.hostname === "app";
  } catch {
    return false;
  }
}
