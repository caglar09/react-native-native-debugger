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
  levels?: Array<'debug' | 'info' | 'warn' | 'error' | string>;
  redactKeys?: string[];
  includeData?: boolean;
  replayBuffered?: boolean;
  silent?: boolean;
  prefix?: string;
  onEvent?: (event: NativeDebugEvent) => void;
  runtimeTelemetry?: boolean;
  telemetryIntervalMs?: number;
};

export type RuntimeMetrics = {
  available: boolean;
  reason?: string;
  source?: string;
  timestamp?: number;
  platform?: 'android' | 'ios' | string;
  process?: string;
  pid?: number;
  residentMemoryBytes?: number;
  memoryKind?: string;
  cpuPercent?: number;
  fps?: number;
  threads?: number;
  thermalState?: string;
  batteryPercent?: number;
  physicalMemoryBytes?: number;
  activeProcessors?: number;
  lowPowerMode?: boolean;
  javaHeapUsedBytes?: number;
  javaHeapMaxBytes?: number;
  nativeHeapAllocatedBytes?: number;
  privateDirtyBytes?: number;
  rxBytes?: number;
  txBytes?: number;
  uptimeMs?: number;
};

export type RuntimeTelemetryOptions = {
  intervalMs?: number;
};

export const EVENT_NAME: string;
export const isAvailable: boolean;
export function subscribe(handler: (event: NativeDebugEvent) => void): { remove(): void };
export function installConsoleTransport(options?: ConsoleTransportOptions): Promise<{ remove(): void }>;
export function getBufferedEvents(): Promise<NativeDebugEvent[]>;
export function clearBufferedEvents(): Promise<void>;
export function setEnabled(enabled: boolean): void;
export function startRuntimeTelemetry(options?: RuntimeTelemetryOptions): void;
export function stopRuntimeTelemetry(): void;
export function getRuntimeMetrics(): Promise<RuntimeMetrics>;
export function redact<T>(value: T, extraKeys?: string[]): T;
