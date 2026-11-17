export const OPENROUTER: { auth: string; exchange: string; keyInfo: string; keysPage: string; creditsPage: string };
export const CODE_LIFE_MS: number;
export class ConnectError extends Error {}
export function challengeOf(verifier: string): string;
export function pkcePair(): { verifier: string; challenge: string };
export function authUrl(challenge: string, options?: { callbackUrl?: string; state?: string; label?: string; site?: string }): string;
export function oneTimeCallback(state: string): {
  readonly url: string;
  readonly port: number;
  start(): Promise<number>;
  wait(ms: number, signal?: AbortSignal): Promise<string>;
  close(): void;
};
export type KeyState = { state: "ok" | "signed_out" | "no_credit" | "unreachable"; label?: string; usage?: number; limit?: number | null; limit_remaining?: number | null };
export function exchange(code: string, verifier: string, options?: { url?: string; fetchImpl?: typeof fetch }): Promise<string>;
export function keyState(key: string, options?: { url?: string; fetchImpl?: typeof fetch }): Promise<KeyState>;
export function connectOpenRouter(options: {
  external?: (localUrl: string) => Promise<string>;
  open: (url: string) => Promise<boolean>;
  signal?: AbortSignal;
  timeoutMs?: number;
  site?: string;
  exchangeUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;
