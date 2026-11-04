import type * as vscode from 'vscode';

export type ProviderProfile = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_mode: string;
};

export function validRoute(raw: any): Omit<ProviderProfile, 'id'>;
export function listProfiles(context: vscode.ExtensionContext): ProviderProfile[];
export function defaultProfileId(context: vscode.ExtensionContext): string;
export function markDefaultProfile(context: vscode.ExtensionContext, id: string): Promise<void>;
export function clearDefaultProfile(context: vscode.ExtensionContext): Promise<void>;
export function addProfile(context: vscode.ExtensionContext, raw: any): Promise<ProviderProfile>;
export function removeProfile(context: vscode.ExtensionContext, id: string): Promise<void>;
export function profileCredential(context: vscode.ExtensionContext, id: string): Promise<{
  route: ProviderProfile;
  api_key: string;
}>;
