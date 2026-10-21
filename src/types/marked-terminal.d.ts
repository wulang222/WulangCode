declare module "marked-terminal" {
  export function markedTerminal(options?: {
    showSectionPrefix?: boolean;
    width?: number;
    reflowText?: boolean;
  }): import("marked").MarkedExtension;
}
