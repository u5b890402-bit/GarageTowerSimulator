declare const process: {
  argv: string[];
  exitCode?: number;
};

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: "utf8"): Promise<void>;
  export function appendFile(path: string, data: string, encoding?: "utf8"): Promise<void>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}
