export interface PtySessionSnapshot {
  id: string;
  buffer: string;
  rawBuffer: string;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  cwd: string;
  presetCommand: string;
  themeId: string;
  provider: string | null;
  createdAt: number;
  resumeId: string | null;
  resumeCommand: string | null;
  agentSessionId: string | null;
  exitState?: unknown;
}

export interface PtyBackendEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string, session?: PtySessionSnapshot) => void;
  onPasteInput?: (id: string, cwd: string) => void;
  onRawData?: (id: string, data: string) => void;
  onAutoSwitchStatus?: (id: string, status: string, detail?: string) => void;
}

export interface PtyBackend {
  create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): Promise<PtySessionSnapshot>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  destroy(id: string): Promise<void>;
  getSession(id: string): PtySessionSnapshot | undefined;
  getAllSessions(): PtySessionSnapshot[];
  captureResumeFromBuffer(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  regenerateTitle(id: string): Promise<void>;
  setProvider(id: string, provider: string | null): Promise<void>;
  refreshSessions(): Promise<PtySessionSnapshot[]>;
  getRawBuffer(id: string): Promise<string>;
  restart(): Promise<void>;
}

