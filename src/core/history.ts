import type { TedDocument } from './types';
export interface HistoryEntry {
  document: TedDocument;
  label: string;
}
export class History {
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  push(before: TedDocument, label: string) {
    this.past.push({ document: structuredClone(before), label });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(current: TedDocument): TedDocument | undefined {
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push({ document: structuredClone(current), label: entry.label });
    return entry.document;
  }
  redo(current: TedDocument): TedDocument | undefined {
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push({ document: structuredClone(current), label: entry.label });
    return entry.document;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
