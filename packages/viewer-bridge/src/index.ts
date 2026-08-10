export type WidgetName = "alivibe" | "phylotagger";

export interface WidgetEnvelope<T = unknown> {
  readonly source: "phylo-workbench" | "phylo-widget";
  readonly widget: WidgetName;
  readonly type: string;
  readonly requestId?: string;
  readonly payload?: T;
  readonly error?: string;
}

export type WidgetEventListener = (message: WidgetEnvelope) => void;

export class WidgetBridge {
  private readonly pending = new Map<string, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<WidgetEventListener>();
  private ready = false;
  private readyResolvers: Array<() => void> = [];
  private sequence = 0;

  constructor(
    readonly widget: WidgetName,
    private readonly target: () => Window | null,
  ) {
    window.addEventListener("message", this.receive);
  }

  private readonly receive = (event: MessageEvent): void => {
    const message = event.data as Partial<WidgetEnvelope> | undefined;
    if (message?.source !== "phylo-widget" || message.widget !== this.widget || typeof message.type !== "string") return;
    if (event.source !== this.target()) return;
    if (message.type === "ready") {
      this.ready = true;
      for (const resolve of this.readyResolvers) resolve();
      this.readyResolvers = [];
    }
    if (message.requestId !== undefined) {
      const request = this.pending.get(message.requestId);
      if (request !== undefined) {
        clearTimeout(request.timeout);
        this.pending.delete(message.requestId);
        if (message.error !== undefined) request.reject(new Error(message.error));
        else request.resolve(message.payload);
      }
    }
    for (const listener of this.listeners) listener(message as WidgetEnvelope);
  };

  async waitUntilReady(timeoutMs = 45_000): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.widget} did not become ready.`)), timeoutMs);
      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<Result = unknown>(type: string, payload?: unknown, timeoutMs = 180_000): Promise<Result> {
    await this.waitUntilReady(timeoutMs);
    const target = this.target();
    if (target === null) throw new Error(`${this.widget} frame is unavailable.`);
    const requestId = `${this.widget}-${Date.now()}-${this.sequence++}`;
    const result = new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.widget} request '${type}' timed out.`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
    const envelope: WidgetEnvelope = {
      source: "phylo-workbench",
      widget: this.widget,
      type,
      requestId,
      ...(payload === undefined ? {} : { payload }),
    };
    target.postMessage(envelope, window.location.origin);
    return result;
  }

  onEvent(listener: WidgetEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.ready = false;
  }

  destroy(): void {
    window.removeEventListener("message", this.receive);
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(`${this.widget} bridge was destroyed.`));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
