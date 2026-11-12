// media/shared/marks.js, as the extension's host sees it (src/dock.ts, src/pipsView.ts).
declare const marks: {
  readonly PALETTES: readonly string[];
  readonly HUES: Readonly<Record<string, number>>;
  readonly SETS: Readonly<Record<string, number>>;
  readonly SET_OF: Readonly<Record<string, string>>;
  readonly COMPUTERS: readonly string[];
  isPalette(name: unknown): name is string;
  label(name: string): string;
  oldPair(id: string): number;
  fromOld(pair: number): string;
  fallback(kind: string, id: string): string;
  pick(around: readonly string[]): string;
  born(id: string, stamp?: unknown): number;
  assign(ask: { kind: string; list: readonly { id: string; born?: number }[]; known: Record<string, string>; since: number }): Record<string, string>;
  computerPalette(n: number): string;
  html(set: string, palette: string, more?: { size?: number; moving?: boolean; id?: string; name?: string }): string;
  of(kind: string, palette: string, more?: { size?: number; moving?: boolean; id?: string; name?: string }): string;
  keeper(post: (message: unknown) => void): { heard(): boolean; said(msg: unknown): void; palette(kind: string, id: string): string;
    wear(kind: string, list: readonly { id: string; born?: number }[]): void; mark(kind: string, id: string, more?: Record<string, unknown>): string };
};
export = marks;
