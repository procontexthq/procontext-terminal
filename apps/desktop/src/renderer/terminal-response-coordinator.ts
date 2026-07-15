import type { TerminalResponseResult } from "@terminal/protocol";

export type TerminalFunctionIdentifier = {
  prefix?: string;
  intermediates?: string;
  final: string;
};

export type TerminalParserLike = {
  registerCsiHandler(
    id: TerminalFunctionIdentifier,
    handler: (params: Array<number | number[]>) => boolean | Promise<boolean>,
  ): { dispose(): void };
  registerDcsHandler?(
    id: TerminalFunctionIdentifier,
    handler: (data: string, params: Array<number | number[]>) => boolean | Promise<boolean>,
  ): { dispose(): void };
};

export type TerminalResponseCoordinator = {
  beginOutput(terminalResponses?: TerminalResponseResult[]): () => void;
  consumeInput(input: string): boolean;
  dispose(): void;
};

type PendingOutput = {
  queryResponses: TerminalResponseResult[];
  exactResponses: TerminalResponseResult[];
};

export function createTerminalResponseCoordinator(
  parser?: TerminalParserLike,
): TerminalResponseCoordinator {
  const pendingOutputs: PendingOutput[] = [];

  const consumePending = (
    key: "queryResponses" | "exactResponses",
    matches: (response: string) => boolean,
  ): TerminalResponseResult | undefined => {
    const pendingResponses = pendingOutputs[0]?.[key];
    if (!pendingResponses) return undefined;
    const index = pendingResponses.findIndex((response) => matches(response.data));
    if (index < 0) return undefined;
    return pendingResponses.splice(index, 1)[0];
  };

  const handlers = registerAnsweredTerminalQueryHandlers(
    parser,
    (matches) => consumePending("queryResponses", matches)?.status === "returned",
  );

  return {
    beginOutput(terminalResponses = []) {
      const output: PendingOutput = {
        queryResponses: parser
          ? terminalResponses.filter((response) => isInterceptedTerminalResponse(response.data))
          : [],
        exactResponses: parser
          ? terminalResponses.filter((response) => !isInterceptedTerminalResponse(response.data))
          : [...terminalResponses],
      };
      pendingOutputs.push(output);
      let pending = true;
      return () => {
        if (!pending) return;
        pending = false;
        const index = pendingOutputs.indexOf(output);
        if (index >= 0) pendingOutputs.splice(index, 1);
      };
    },
    consumeInput(input) {
      return (
        consumePending("exactResponses", (response) => response === input)?.status === "returned"
      );
    },
    dispose() {
      for (const handler of handlers) handler.dispose();
      pendingOutputs.length = 0;
    },
  };
}

function registerAnsweredTerminalQueryHandlers(
  parser: TerminalParserLike | undefined,
  consume: (matches: (response: string) => boolean) => boolean,
): Array<{ dispose(): void }> {
  if (!parser) return [];
  const handlers = [
    parser.registerCsiHandler({ final: "c" }, (params) =>
      firstNumericParam(params) === 0
        ? consume((response) => matchesCsiResponse(response, "?", /^[0-9;]+c$/))
        : false,
    ),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, (params) =>
      firstNumericParam(params) === 0
        ? consume((response) => matchesCsiResponse(response, ">", /^[0-9;]+c$/))
        : false,
    ),
    parser.registerCsiHandler({ final: "n" }, (params) =>
      consumeDeviceStatusResponse(params, false, consume),
    ),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) =>
      consumeDeviceStatusResponse(params, true, consume),
    ),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, (params) =>
      consumeModeReport(params, false, consume),
    ),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) =>
      consumeModeReport(params, true, consume),
    ),
    parser.registerCsiHandler({ final: "t" }, (params) =>
      firstNumericParam(params) === 18
        ? consume((response) => matchesCsiResponse(response, "", /^8;\d+;\d+t$/))
        : false,
    ),
  ];
  if (parser.registerDcsHandler) {
    handlers.push(
      parser.registerDcsHandler({ intermediates: "$", final: "q" }, () =>
        consume((response) => response.startsWith("\u001bP") && response.endsWith("\u001b\\")),
      ),
    );
  }
  return handlers;
}

function consumeDeviceStatusResponse(
  params: Array<number | number[]>,
  decPrivate: boolean,
  consume: (matches: (response: string) => boolean) => boolean,
): boolean {
  const status = firstNumericParam(params);
  if (!decPrivate && status === 5) {
    return consume((response) => response === "\u001b[0n");
  }
  if (status !== 6) return false;
  return consume((response) =>
    decPrivate
      ? matchesCsiResponse(response, "?", /^\d+;\d+R$/)
      : matchesCsiResponse(response, "", /^\d+;\d+R$/),
  );
}

function consumeModeReport(
  params: Array<number | number[]>,
  decPrivate: boolean,
  consume: (matches: (response: string) => boolean) => boolean,
): boolean {
  const mode = firstNumericParam(params);
  if (mode === undefined) return false;
  const prefix = `\u001b[${decPrivate ? "?" : ""}${mode};`;
  return consume(
    (response) => response.startsWith(prefix) && /^[0-4]\$y$/.test(response.slice(prefix.length)),
  );
}

function firstNumericParam(params: Array<number | number[]>): number | undefined {
  const value = params[0];
  return typeof value === "number" ? value : undefined;
}

function matchesCsiResponse(response: string, prefix: string, body: RegExp): boolean {
  const start = `\u001b[${prefix}`;
  return response.startsWith(start) && body.test(response.slice(start.length));
}

function isInterceptedTerminalResponse(response: string): boolean {
  return (
    response === "\u001b[0n" ||
    matchesCsiResponse(response, "?", /^[0-9;]+c$/) ||
    matchesCsiResponse(response, ">", /^[0-9;]+c$/) ||
    matchesCsiResponse(response, "", /^\d+;\d+R$/) ||
    matchesCsiResponse(response, "?", /^\d+;\d+R$/) ||
    matchesCsiResponse(response, "", /^\??\d+;[0-4]\$y$/) ||
    matchesCsiResponse(response, "", /^8;\d+;\d+t$/) ||
    (response.startsWith("\u001bP") && response.endsWith("\u001b\\"))
  );
}
