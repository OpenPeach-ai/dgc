import type * as vscode from 'vscode';

export type ProviderProfile = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_mode: string;
  kind?: 'native';
  engine?: never;
} | {
  id: string;
  kind: 'subscription';
  engine: 'claude' | 'codex';
  name: string;
  model: string;
  base_url?: never;
  api_mode?: never;
};

export function validRoute(raw: any): Omit<ProviderProfile, 'id'>;
export function listProfiles(context: vscode.ExtensionContext): ProviderProfile[];
export function defaultProfileId(context: vscode.ExtensionContext): string;
export function markDefaultProfile(context: vscode.ExtensionContext, id: string, model?: string): Promise<void>;
export function startingModel(context: vscode.ExtensionContext, row: ProviderProfile | undefined): string;
export function hasRunnableProfile(context: vscode.ExtensionContext): boolean;
export function clearDefaultProfile(context: vscode.ExtensionContext): Promise<void>;
export function addProfile(context: vscode.ExtensionContext, raw: any): Promise<ProviderProfile>;
export function removeProfile(context: vscode.ExtensionContext, id: string): Promise<void>;
export function profileCredential(context: vscode.ExtensionContext, id: string): Promise<{
  route: ProviderProfile;
  api_key: string;
}>;
export function adoptWorkingRoute(context: vscode.ExtensionContext, ready: unknown, presets: unknown): Promise<ProviderProfile | null>;
export function firstTakesDefault(context: vscode.ExtensionContext, ready: unknown): boolean;
