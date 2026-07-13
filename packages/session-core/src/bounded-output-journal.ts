type OutputEntry = {
  version: number;
  data: string;
  bytes: number;
};

export type OutputJournalRead = {
  data: string;
  truncated: boolean;
};

export class BoundedOutputJournal {
  private readonly entries: OutputEntry[] = [];
  private retainedBytes = 0;
  private truncatedThroughVersion = -1;

  constructor(private readonly maxBytes: number) {}

  append(version: number, data: string): void {
    if (data.length === 0) return;
    const entry = { version, data, bytes: Buffer.byteLength(data) };
    this.entries.push(entry);
    this.retainedBytes += entry.bytes;
    this.trim();
  }

  read(afterVersion?: number): OutputJournalRead {
    return {
      data: this.entries
        .filter((entry) => afterVersion === undefined || entry.version > afterVersion)
        .map((entry) => entry.data)
        .join(""),
      truncated:
        afterVersion === undefined
          ? this.truncatedThroughVersion >= 0
          : afterVersion < this.truncatedThroughVersion,
    };
  }

  private trim(): void {
    while (this.retainedBytes > this.maxBytes) {
      const first = this.entries[0];
      if (!first) return;
      const excess = this.retainedBytes - this.maxBytes;
      this.truncatedThroughVersion = Math.max(this.truncatedThroughVersion, first.version);
      if (first.bytes <= excess) {
        this.entries.shift();
        this.retainedBytes -= first.bytes;
        continue;
      }

      const trimmed = trimUtf8Start(first.data, excess);
      this.retainedBytes -= first.bytes;
      first.data = trimmed;
      first.bytes = Buffer.byteLength(trimmed);
      this.retainedBytes += first.bytes;
    }
  }
}

function trimUtf8Start(value: string, minimumBytes: number): string {
  const bytes = Buffer.from(value);
  let start = Math.min(minimumBytes, bytes.length);
  while (start < bytes.length && (bytes[start] ?? 0) >> 6 === 0b10) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
