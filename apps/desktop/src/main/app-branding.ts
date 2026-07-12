export const PRODUCT_NAME = "ProContext Terminal";

export function shouldSetDevelopmentDockIcon(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): boolean {
  return platform === "darwin" && !isPackaged;
}
