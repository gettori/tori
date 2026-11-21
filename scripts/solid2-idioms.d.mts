import type ts from "typescript";

export interface IdiomHit {
  class: string;
  file: string;
  line: number;
}

export function scan(
  typescript: typeof ts,
  file: string,
  source: string,
  report?: { bump?: (label: string, file: string) => void; note?: (key: string, at: string) => void },
): IdiomHit[];
