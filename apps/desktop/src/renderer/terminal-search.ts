export type TerminalSearchOptions = {
  incremental: boolean;
};

export type TerminalSearchTarget = {
  findNext(query: string, options: TerminalSearchOptions): boolean;
  findPrevious(query: string, options: TerminalSearchOptions): boolean;
  clearDecorations(): void;
};
