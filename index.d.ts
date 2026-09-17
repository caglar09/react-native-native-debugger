export type NativeDebugEvent = {
  id: string;
  timestamp: number;
  platform: 'android' | 'ios' | string;
  integration: string;
  category: string;
  event: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | string;
  data: Record<string, unknown>;
};

export type ConsoleTransportOptions = {
  integrations?: string[];
  categories?: string[];
  events?: string[];
  redactKeys?: string[];
  includeData?: boolean;
  replayBuffered?: boolean;
  silent?: boolean;
  prefix?: string;
  onEvent?: (event: NativeDebugEvent) => void;
};

export const EVENT_NAME: string;
export const isAvailable: boolean;
export function subscribe(handler: (event: NativeDebugEvent) => void): { remove(): void };
export function installConsoleTransport(options?: ConsoleTransportOptions): Promise<{ remove(): void }>;
export function getBufferedEvents(): Promise<NativeDebugEvent[]>;
export function clearBufferedEvents(): Promise<void>;
export function setEnabled(enabled: boolean): void;
export function redact<T>(value: T, extraKeys?: string[]): T;
