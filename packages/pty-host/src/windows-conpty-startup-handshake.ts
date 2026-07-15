const DEVICE_ATTRIBUTES_QUERY = "\u001b[c";
const XTERM_DEVICE_ATTRIBUTES_RESPONSE = "\u001b[?1;2c";
const STARTUP_SCAN_LENGTH = 64;

type HandshakeResult = {
  output: string;
  response?: string;
};

export class WindowsConptyStartupHandshake {
  private active = true;
  private pending = "";
  private receivedLength = 0;

  accept(data: string): HandshakeResult {
    if (!this.active) {
      return { output: data };
    }

    const combinedStart = this.receivedLength - this.pending.length;
    const combined = this.pending + data;
    this.pending = "";
    this.receivedLength += data.length;

    const queryIndex = combined.indexOf(DEVICE_ATTRIBUTES_QUERY);
    if (queryIndex >= 0 && combinedStart + queryIndex < STARTUP_SCAN_LENGTH) {
      this.active = false;
      return {
        output:
          combined.slice(0, queryIndex) +
          combined.slice(queryIndex + DEVICE_ATTRIBUTES_QUERY.length),
        response: XTERM_DEVICE_ATTRIBUTES_RESPONSE,
      };
    }

    const pendingLength = findPendingQueryPrefixLength(combined, combinedStart);
    if (pendingLength > 0) {
      this.pending = combined.slice(-pendingLength);
    } else if (this.receivedLength >= STARTUP_SCAN_LENGTH) {
      this.active = false;
    }

    return {
      output: combined.slice(0, combined.length - pendingLength),
    };
  }

  finish(): string {
    this.active = false;
    const output = this.pending;
    this.pending = "";
    return output;
  }
}

function findPendingQueryPrefixLength(data: string, dataStart: number): number {
  const maximumLength = Math.min(DEVICE_ATTRIBUTES_QUERY.length - 1, data.length);
  for (let length = maximumLength; length > 0; length -= 1) {
    const suffixStart = data.length - length;
    if (dataStart + suffixStart >= STARTUP_SCAN_LENGTH) {
      continue;
    }
    if (data.endsWith(DEVICE_ATTRIBUTES_QUERY.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
