declare module 'js-yaml' {
  export function load(source: string): unknown;
  export function dump(value: unknown, options?: { lineWidth?: number; noRefs?: boolean }): string;
}
