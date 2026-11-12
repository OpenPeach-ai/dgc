// What the extension host uses of src/pipProjects.js (the page's own module, plain JavaScript).
export const PROJECTS_API: number;
export const PROJECT_COMMANDS: string[];
export const PROJECT_WORK_COMMAND: string;
export type ProjectChange = { id: string; workspace_id: string; name: string; status: string; files: { path: string; change: string; plus?: number; minus?: number; binary?: boolean }[]; more: number; digest: string };
export function pipProjectsRefusal(request: unknown, apiVersion: number): string;
export function projectChange(value: unknown): ProjectChange;
export function projectWorkRequest(request: unknown): boolean;
export function projectWorkBrief(change: ProjectChange, options?: { pipName?: string; file?: string; cut?: boolean }): string;
export function patchFileName(change: ProjectChange): string;
