// ACP Session View — structured rendering of ACP session/update events.
// Redesigned to match mainstream agent desktop UIs (Cursor / Devin / Windsurf / Cline).
// Full-width message blocks, agent avatars, compact tool cards, modern input bar.

import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  PromptCapabilities,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import {
  AcpPromptQueue,
  availableSlashCommands,
  configControlLabel,
  configValueLabel,
  type ContextUsageState,
  imageContentFromDataUrl,
  normalizeContextUsage,
  slashCommandCompletion,
  statusConfigOptions,
} from './acp-session-state';
import { getAgentLogo } from './agent-logos';
import { AcpPromptHistory, canNavigatePromptHistory } from './acp-prompt-history';
import {
  DEFAULT_CONVERSATION_PREFERENCES,
  type ConversationPreferences,
} from './conversation-preferences';

type AgentMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
type UserMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' }>;
type AgentThoughtChunkUpdate = Extract<SessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
type ToolCallProgressUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
type PlanUpdate = Extract<SessionUpdate, { sessionUpdate: 'plan' }>;
type UsageSessionUpdate = Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;

export interface AcpSessionInfo {
  id: string;
  agentLabel: string;
  cwd: string;
  sessionId: string | null;
  configOptions: SessionConfigOption[];
  promptCapabilities?: PromptCapabilities | null;
  status: 'initializing' | 'ready' | 'prompting' | 'idle' | 'error' | 'closed';
  errorMessage?: string;
  startupPhase?: 'loading-adapter' | 'spawning-adapter' | 'connecting' | 'initializing-protocol' | 'creating-session' | 'loading-session' | 'applying-config' | 'ready';
  startupTimingsMs?: Partial<Record<string, number>>;
  supportsPromptRollback?: boolean;
  replayUpdates?: SessionUpdate[];
}

interface ToolCallState {
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  expanded: boolean;
  activityGroup?: HTMLDetailsElement;
  // Wall-clock when the call first appeared (for subagent elapsed display). Set once on creation.
  startedMs?: number;
}

interface ComposerImage {
  dataUrl: string;
  name: string;
}

// A non-image document dropped onto the composer. ACP has no native file/resource content
// block transport, so on submit these are appended to the prompt text as absolute paths
// (the agent reads them as file references). `error` marks a chip that could not be attached
// (directory, oversized, unreadable) so it stays visible but is excluded from the payload.
interface ComposerFile {
  path: string;
  name: string;
  size: number;
  error?: string;
}

interface QueuedPrompt {
  blocks: ContentBlock[];
  text: string;
  images: ComposerImage[];
}

export type SessionLinkDisposition = 'embedded' | 'external';
export type SessionLinkHandler = (url: string, disposition: SessionLinkDisposition) => void | Promise<void>;

// Agent brand colors for avatars
const AGENT_COLORS: Record<string, string> = {
  Claude: '#d97757',
  Codex: '#10a37f',
  Copilot: '#6366f1',
  Kiro: '#8b5cf6',
  OpenCode: '#f59e0b',
};

const BOTTOM_PROXIMITY_PX = 72;

export class AcpSessionView {
  private container: HTMLElement;
  private scrollEl: HTMLElement;
  private jumpToBottomBtn: HTMLButtonElement;
  private messagesEl: HTMLElement;
  private inputWrapEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private slashCommandsEl: HTMLElement;
  private attachmentsEl: HTMLElement;
  private composerEl: HTMLElement;
  private imageInputEl: HTMLInputElement;
  private queueEl: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private statusbarEl: HTMLElement;
  private sessionId: string;
  private agentLabel: string;
  private cwd: string;
  private agentColor: string;
  private agentLogoMarkup: string;
  private configOptions: SessionConfigOption[] = [];
  private status: AcpSessionInfo['status'] = 'initializing';
  private toolCalls = new Map<string, ToolCallState>();
  // 1s tick that re-renders only in-progress subagent panels so their elapsed timer updates
  // live. Allocated lazily and cleared as soon as no subagent is still running.
  private subagentTickHandle: ReturnType<typeof setInterval> | null = null;
  private currentMessageEl: HTMLElement | null = null;
  private currentUserMessageEl: HTMLElement | null = null;
  private currentThoughtEl: HTMLElement | null = null;
  private currentActivityEl: HTMLDetailsElement | null = null;
  private currentActivityContentEl: HTMLElement | null = null;
  private isPrompting = false;
  private supportsImages: boolean | null = null;
  private availableCommands: AvailableCommand[] = [];
  private filteredCommands: AvailableCommand[] = [];
  private activeCommandIndex = 0;
  private composerImages: ComposerImage[] = [];
  private composerFiles: ComposerFile[] = [];
  private promptQueue = new AcpPromptQueue<QueuedPrompt>();
  private contextUsage: ContextUsageState | undefined;
  private planEl: HTMLElement | null = null;
  private planEntries: PlanEntry[] = [];
  private typingIndicatorEl: HTMLElement;
  private conversationPreferences: ConversationPreferences;
  private promptHistory = new AcpPromptHistory();
  private promptHistoryKey: string;
  private replayUserFallbackRendered = false;
  private startupPhase: AcpSessionInfo['startupPhase'];
  private openSessionLink: SessionLinkHandler;
  private retrySession: (() => void | Promise<void>) | null;
  private errorEl: HTMLElement | null = null;
  private followsLatest = true;
  private messagesResizeObserver: ResizeObserver;
  private isReplayingHistory = false;
  private destroyed = false;

  constructor(
    sessionId: string,
    agentLabel: string,
    cwd: string,
    conversationPreferences: ConversationPreferences = DEFAULT_CONVERSATION_PREFERENCES,
    openSessionLink: SessionLinkHandler = () => undefined,
    retrySession: (() => void | Promise<void>) | null = null,
  ) {
    this.sessionId = sessionId;
    this.agentLabel = agentLabel;
    this.cwd = cwd;
    this.conversationPreferences = { ...conversationPreferences };
    this.openSessionLink = openSessionLink;
    this.retrySession = retrySession;
    this.promptHistoryKey = this.historyStorageKey(sessionId);
    this.promptHistory = AcpPromptHistory.load(this.promptHistoryKey);
    const agentName = Object.keys(AGENT_COLORS).find(name => agentLabel.startsWith(name));
    this.agentColor = agentName ? AGENT_COLORS[agentName] : '#6b7280';
    this.agentLogoMarkup = agentName ? getAgentLogo(agentName)?.markup || '' : '';

    this.container = document.createElement('div');
    this.container.className = 'acp-session-view';

    const avatarContent = this.agentLogoMarkup || this.escapeHtml(agentLabel.charAt(0).toUpperCase());
    const safeAgent = this.escapeHtml(agentLabel);
    const safeCwd = this.escapeHtml(this.shortPath(cwd));

    this.container.innerHTML = `
      <div class="acp-scroll-shell">
        <div class="acp-scroll" id="acp-scroll-${sessionId}">
          <div class="acp-messages" id="acp-messages-${sessionId}">
            <div class="acp-welcome">
              <div class="acp-welcome-avatar acp-agent-logo" style="background:${this.agentColor}">${avatarContent}</div>
              <div class="acp-welcome-title">${safeAgent}</div>
              <div class="acp-welcome-sub">Ready to work in <code>${safeCwd}</code></div>
            </div>
            <div class="acp-typing-indicator" id="acp-typing-${sessionId}" style="display:none;" aria-label="Agent is working">
              <span class="acp-typing-dot"></span>
              <span class="acp-typing-dot"></span>
              <span class="acp-typing-dot"></span>
            </div>
          </div>
        </div>
        <button class="acp-jump-bottom" id="acp-jump-bottom-${sessionId}" type="button" title="Jump to latest message" aria-label="Jump to latest message" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
        </button>
      </div>
      <div class="acp-composer-dock">
        <div class="acp-composer">
          <div class="acp-queue" id="acp-queue-${sessionId}" style="display:none;"></div>
          <div class="acp-attachments" id="acp-attachments-${sessionId}" style="display:none;"></div>
          <div class="acp-slash-commands" id="acp-slash-commands-${sessionId}" role="listbox" aria-label="Available agent commands" hidden></div>
          <div class="acp-input-wrap" id="acp-input-wrap-${sessionId}">
            <input class="acp-image-input" id="acp-image-input-${sessionId}" type="file" accept="image/*" hidden>
            <textarea class="acp-input" id="acp-input-${sessionId}"
              placeholder="Ask ${safeAgent} to do anything…"
              aria-autocomplete="list"
              aria-controls="acp-slash-commands-${sessionId}"
              aria-expanded="false"
              rows="1"></textarea>
            <button class="acp-cancel-btn" id="acp-cancel-${sessionId}" style="display:none;" title="Cancel (Esc)" aria-label="Cancel current response">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
            <button class="acp-send-btn" id="acp-send-${sessionId}" title="Send (Enter)" aria-label="Send message">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8l12-5-5 12-2-5-5-2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="acp-statusbar" id="acp-statusbar-${sessionId}"></div>
        </div>
      </div>
    `;

    this.scrollEl = this.requiredElement(`#acp-scroll-${sessionId}`);
    this.jumpToBottomBtn = this.requiredElement(`#acp-jump-bottom-${sessionId}`);
    this.messagesEl = this.requiredElement(`#acp-messages-${sessionId}`);
    this.inputWrapEl = this.requiredElement(`#acp-input-wrap-${sessionId}`);
    this.inputEl = this.requiredElement(`#acp-input-${sessionId}`);
    this.slashCommandsEl = this.requiredElement(`#acp-slash-commands-${sessionId}`);
    this.attachmentsEl = this.requiredElement(`#acp-attachments-${sessionId}`);
    this.composerEl = this.requiredElement(`.acp-composer`);
    this.imageInputEl = this.requiredElement(`#acp-image-input-${sessionId}`);
    this.queueEl = this.requiredElement(`#acp-queue-${sessionId}`);
    this.sendBtn = this.requiredElement(`#acp-send-${sessionId}`);
    this.cancelBtn = this.requiredElement(`#acp-cancel-${sessionId}`);
    this.statusbarEl = this.requiredElement(`#acp-statusbar-${sessionId}`);
    this.typingIndicatorEl = this.requiredElement(`#acp-typing-${sessionId}`);

    this.setupEvents();
    this.messagesResizeObserver = new ResizeObserver(() => {
      if (this.followsLatest) this.scrollToBottom();
      else this.updateJumpToBottomVisibility();
    });
    this.messagesResizeObserver.observe(this.messagesEl);
    this.renderStatusbar();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  setConversationPreferences(preferences: ConversationPreferences): void {
    this.conversationPreferences = { ...preferences };
    for (const thought of Array.from(this.messagesEl.querySelectorAll<HTMLDetailsElement>('.acp-thought'))) {
      thought.open = preferences.expandThoughtsByDefault;
    }
    for (const state of this.toolCalls.values()) {
      state.expanded = preferences.expandToolsByDefault || state.status === 'failed';
      this.renderToolCall(state, true);
    }
    for (const group of Array.from(this.messagesEl.querySelectorAll<HTMLDetailsElement>('.acp-activity-group'))) {
      group.open = preferences.expandThoughtsByDefault || preferences.expandToolsByDefault;
    }
  }

  private setupEvents(): void {
    this.sendBtn.addEventListener('click', () => this.submitComposer('queue'));
    this.cancelBtn.addEventListener('click', () => this.cancelPrompt());
    this.jumpToBottomBtn.addEventListener('click', () => this.scrollToBottom(true));
    this.scrollEl.addEventListener('scroll', () => {
      this.followsLatest = this.isNearBottom();
      this.updateJumpToBottomVisibility();
    }, { passive: true });
    this.messagesEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[href]');
      if (!link || !this.messagesEl.contains(link)) return;
      const url = link.href;
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;
      event.preventDefault();
      event.stopPropagation();
      const disposition: SessionLinkDisposition = event.ctrlKey || event.metaKey ? 'external' : 'embedded';
      void Promise.resolve(this.openSessionLink(url, disposition)).catch((error) => {
        console.error('[ACP] Failed to open session link:', error);
      });
    });

    this.inputEl.addEventListener('input', () => {
      this.autoGrowInput();
      this.promptHistory.reset();
      this.activeCommandIndex = 0;
      this.renderSlashCommands();
    });
    this.inputEl.addEventListener('focus', () => this.renderSlashCommands());
    this.inputEl.addEventListener('blur', () => this.closeSlashCommands());

    this.inputEl.addEventListener('paste', (event) => this.handleImagePaste(event));
    this.imageInputEl.addEventListener('change', () => {
      const file = this.imageInputEl.files?.[0];
      if (file) this.addComposerImage(file);
      this.imageInputEl.value = '';
    });

    // Drag-and-drop documents/files onto the composer (#107). Images route to the existing
    // image-attach path; other files become path-reference chips appended to the prompt on
    // submit. Directories are rejected via webkitGetAsEntry. preventDefault on dragover also
    // stops Electron from navigating the window to the dropped file.
    this.setupComposerDrop();

    this.inputEl.addEventListener('keydown', (e) => {
      if (this.handleSlashCommandKeydown(e)) return;
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const direction = e.key === 'ArrowUp' ? 'older' : 'newer';
        if (canNavigatePromptHistory(
          this.inputEl.value,
          this.inputEl.selectionStart,
          this.inputEl.selectionEnd,
          direction,
        )) {
          const recalled = this.promptHistory.navigate(direction, this.inputEl.value);
          if (recalled !== null) {
            e.preventDefault();
            this.inputEl.value = recalled;
            this.autoGrowInput();
            this.inputEl.setSelectionRange(recalled.length, recalled.length);
            return;
          }
        }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submitComposer('interrupt');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.submitComposer('queue');
        return;
      }
      if (e.key === 'Escape' && this.isPrompting) {
        e.preventDefault();
        this.cancelPrompt();
      }
    });
  }

  private handleSlashCommandKeydown(event: KeyboardEvent): boolean {
    if (this.slashCommandsEl.hidden || this.filteredCommands.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.activeCommandIndex = (
        this.activeCommandIndex + delta + this.filteredCommands.length
      ) % this.filteredCommands.length;
      this.renderSlashCommands(false);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.completeSlashCommand(this.filteredCommands[this.activeCommandIndex]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeSlashCommands();
      return true;
    }
    return false;
  }

  private renderSlashCommands(recalculate = true): void {
    if (recalculate) {
      this.filteredCommands = availableSlashCommands(this.availableCommands, this.inputEl.value);
    }
    if (this.filteredCommands.length === 0) {
      this.closeSlashCommands();
      return;
    }
    this.activeCommandIndex = Math.min(this.activeCommandIndex, this.filteredCommands.length - 1);
    this.slashCommandsEl.innerHTML = '';
    this.filteredCommands.forEach((command, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'acp-slash-command';
      option.id = `${this.slashCommandsEl.id}-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === this.activeCommandIndex));
      if (index === this.activeCommandIndex) option.classList.add('acp-slash-command--active');

      const name = document.createElement('span');
      name.className = 'acp-slash-command__name';
      name.textContent = `/${command.name.trim()}`;
      const detail = document.createElement('span');
      detail.className = 'acp-slash-command__detail';
      detail.textContent = command.description;
      option.append(name, detail);

      const hint = command.input?.hint?.trim();
      if (hint) {
        const inputHint = document.createElement('span');
        inputHint.className = 'acp-slash-command__hint';
        inputHint.textContent = hint;
        option.appendChild(inputHint);
      }
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => this.completeSlashCommand(command));
      this.slashCommandsEl.appendChild(option);
    });
    this.slashCommandsEl.hidden = false;
    this.inputEl.setAttribute('aria-expanded', 'true');
    this.inputEl.setAttribute(
      'aria-activedescendant',
      `${this.slashCommandsEl.id}-option-${this.activeCommandIndex}`,
    );
    this.slashCommandsEl.querySelector('.acp-slash-command--active')?.scrollIntoView({ block: 'nearest' });
  }

  private completeSlashCommand(command: AvailableCommand | undefined): void {
    if (!command) return;
    const completion = slashCommandCompletion(command);
    this.inputEl.value = completion;
    this.autoGrowInput();
    this.promptHistory.reset();
    this.closeSlashCommands();
    this.inputEl.focus();
    this.inputEl.setSelectionRange(completion.length, completion.length);
  }

  private closeSlashCommands(): void {
    this.slashCommandsEl.hidden = true;
    this.filteredCommands = [];
    this.inputEl.setAttribute('aria-expanded', 'false');
    this.inputEl.removeAttribute('aria-activedescendant');
  }

  private autoGrowInput(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
  }

  private handleImagePaste(event: ClipboardEvent): void {
    const imageItem = Array.from(event.clipboardData?.items || [])
      .find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!imageItem) return;
    event.preventDefault();
    if (this.supportsImages === false) {
      this.addSystemMessage(`${this.agentLabel} does not advertise image prompt support.`);
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) return;
    this.addComposerImage(file);
  }

  private addComposerImage(file: File): void {
    if (this.supportsImages === false) {
      this.addSystemMessage(`${this.agentLabel} does not advertise image prompt support.`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.addSystemMessage('Screenshot is larger than 10 MB.');
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string' || !imageContentFromDataUrl(reader.result)) return;
      this.composerImages.push({
        dataUrl: reader.result,
        name: file.name || `Screenshot ${this.composerImages.length + 1}`,
      });
      this.renderAttachments();
    });
    reader.readAsDataURL(file);
  }

  private renderAttachments(): void {
    this.attachmentsEl.innerHTML = '';
    const hasAny = this.composerImages.length > 0 || this.composerFiles.length > 0;
    this.attachmentsEl.style.display = hasAny ? 'flex' : 'none';
    this.composerImages.forEach((image, index) => {
      const chip = document.createElement('div');
      chip.className = 'acp-attachment-chip';
      const preview = document.createElement('img');
      preview.src = image.dataUrl;
      preview.alt = image.name;
      const name = document.createElement('span');
      name.className = 'acp-attachment-name';
      name.textContent = image.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'acp-attachment-remove';
      remove.textContent = '×';
      remove.title = 'Remove screenshot';
      remove.addEventListener('click', () => {
        this.composerImages.splice(index, 1);
        this.renderAttachments();
      });
      chip.append(preview, name, remove);
      this.attachmentsEl.appendChild(chip);
    });
    this.composerFiles.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'acp-attachment-chip acp-file-chip' + (file.error ? ' acp-file-chip-error' : '');
      const icon = document.createElement('span');
      icon.className = 'acp-file-chip-icon';
      icon.textContent = '📄';
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'acp-attachment-name';
      name.textContent = file.name;
      if (file.error) name.title = file.error;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'acp-attachment-remove';
      remove.textContent = '×';
      remove.title = 'Remove file';
      remove.addEventListener('click', () => {
        this.composerFiles.splice(index, 1);
        this.renderAttachments();
      });
      chip.append(icon, name, remove);
      this.attachmentsEl.appendChild(chip);
    });
  }

  // Drag-and-drop wiring for the composer. Images are delegated to addComposerImage (native
  // image content blocks); other files become ComposerFile path-reference chips. Directories
  // are rejected via the web entry API so a folder drop surfaces an actionable chip rather
  // than silently being treated as a file.
  private setupComposerDrop(): void {
    const composer = this.composerEl;
    composer.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      composer.classList.add('acp-composer-drag-over');
    });
    composer.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && composer.contains(e.relatedTarget as Node)) return;
      e.stopPropagation();
      composer.classList.remove('acp-composer-drag-over');
    });
    composer.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      composer.classList.remove('acp-composer-drag-over');
      const items = Array.from(e.dataTransfer.items || []);
      // Prefer the entry API so directories can be distinguished from files.
      const entries = items
        .map(item => item.webkitGetAsEntry?.())
        .filter((entry): entry is FileSystemEntry => !!entry);
      if (entries.length > 0) {
        for (const entry of entries) this.addDroppedEntry(entry);
        return;
      }
      // Fallback: no entry API — treat each File directly (path-based, no dir detection).
      for (const file of Array.from(e.dataTransfer.files || [])) {
        this.addComposerFileFromElectronFile(file);
      }
    });
  }

  private addDroppedEntry(entry: FileSystemEntry): void {
    if (entry.isDirectory) {
      this.composerFiles.push({
        path: entry.name,
        name: entry.name,
        size: 0,
        error: 'Directories are not supported. Drop individual files.',
      });
      this.renderAttachments();
      return;
    }
    if (!entry.isFile) return;
    const fileEntry = entry as FileSystemFileEntry;
    fileEntry.file((file) => this.addComposerFileFromElectronFile(file), () => {
      this.composerFiles.push({
        path: entry.name,
        name: entry.name,
        size: 0,
        error: 'Could not read dropped file.',
      });
      this.renderAttachments();
    });
  }

  private addComposerFileFromElectronFile(file: File): void {
    // Images (sized within limits) go through the existing image-attach path so they ship
    // as real image content blocks. Everything else becomes a path-reference chip.
    if (file.type.startsWith('image/')) {
      this.addComposerImage(file);
      return;
    }
    const maxBytes = 25 * 1024 * 1024;
    const filePath = (file as File & { path?: string }).path || file.name;
    if (!filePath || filePath === file.name) {
      // No resolvable absolute path (e.g. some web drops) — can't produce a stable reference.
      this.composerFiles.push({
        path: file.name,
        name: file.name,
        size: file.size,
        error: 'No absolute path available; drop files from Finder instead.',
      });
      this.renderAttachments();
      return;
    }
    if (file.size > maxBytes) {
      this.composerFiles.push({
        path: filePath,
        name: file.name,
        size: file.size,
        error: `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      });
      this.renderAttachments();
      return;
    }
    this.composerFiles.push({ path: filePath, name: file.name, size: file.size });
    this.renderAttachments();
  }

  private renderQueue(): void {
    this.queueEl.innerHTML = '';
    const interrupt = this.promptQueue.interruptItem();
    const queued = this.promptQueue.queuedItems();
    this.queueEl.style.display = interrupt || queued.length > 0 ? 'flex' : 'none';

    const appendItem = (message: QueuedPrompt, label: string, removableIndex?: number): void => {
      const item = document.createElement('div');
      item.className = 'acp-queue-item';
      const badge = document.createElement('span');
      badge.className = 'acp-queue-badge';
      badge.textContent = label;
      const summary = document.createElement('span');
      summary.className = 'acp-queue-summary';
      summary.textContent = message.text || `${message.images.length} screenshot${message.images.length === 1 ? '' : 's'}`;
      item.append(badge, summary);
      if (removableIndex !== undefined) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'acp-queue-remove';
        remove.textContent = '×';
        remove.title = 'Remove queued message';
        remove.addEventListener('click', () => {
          this.promptQueue.removeQueued(removableIndex);
          this.renderQueue();
        });
        item.appendChild(remove);
      }
      this.queueEl.appendChild(item);
    };

    if (interrupt) appendItem(interrupt, 'Next');
    queued.forEach((message, index) => appendItem(message, 'Queued', index));
  }

  private submitComposer(mode: 'queue' | 'interrupt'): void {
    const message = this.captureComposer();
    if (!message) return;

    if (!this.isPrompting) {
      void this.runPrompt(message);
      return;
    }

    if (mode === 'interrupt') {
      this.promptQueue.setInterruptNext(message);
      void this.cancelPrompt();
    } else {
      this.promptQueue.enqueue(message);
    }
    this.renderQueue();
  }

  private captureComposer(): QueuedPrompt | null {
    const typed = this.inputEl.value.trim();
    const images = this.composerImages.slice();
    // Only valid (non-error) file references are appended to the prompt; errored chips are
    // dropped silently on submit so the user isn't forced to remove them first.
    const files = this.composerFiles.filter(f => !f.error);
    if (!typed && images.length === 0 && files.length === 0) return null;

    // ACP has no native file/resource content block, so dropped documents ride as absolute
    // path references appended to the prompt text on their own line. The agent reads them as
    // file references. Ordering is stable (drag order preserved).
    const pathBlock = files.length > 0
      ? files.map(f => f.path).join('\n')
      : '';
    const text = pathBlock ? (typed ? `${typed}\n${pathBlock}` : pathBlock) : typed;

    const blocks: ContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const image of images) {
      const block = imageContentFromDataUrl(image.dataUrl);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) return null;

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.composerImages = [];
    this.composerFiles = [];
    this.renderAttachments();
    return { blocks, text, images };
  }

  private async runPrompt(message: QueuedPrompt): Promise<void> {
    if (message.images.length > 0 && this.supportsImages === false) {
      this.addSystemMessage(`${this.agentLabel} does not advertise image prompt support.`);
      this.drainPromptQueue();
      return;
    }

    if (message.text) {
      this.promptHistory.add(message.text);
      this.promptHistory.save(this.promptHistoryKey);
    }
    this.addUserMessage(message.text, message.images);
    this.setPrompting(true);

    try {
      await window.posse.acpPrompt(this.sessionId, message.blocks);
    } catch (err) {
      this.addSystemMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.setPrompting(false);
      this.drainPromptQueue();
    }
  }

  private drainPromptQueue(): void {
    const next = this.promptQueue.next();
    this.renderQueue();
    if (next) void this.runPrompt(next);
  }

  private async cancelPrompt(): Promise<void> {
    try {
      await window.posse.acpCancel(this.sessionId);
    } catch (err) {
      console.error('[ACP] Cancel failed:', err);
    }
  }

  private setPrompting(on: boolean): void {
    this.isPrompting = on;
    this.sendBtn.style.display = '';
    this.cancelBtn.style.display = on ? '' : 'none';
    this.typingIndicatorEl.style.display = on ? 'flex' : 'none';
    this.inputEl.placeholder = on ? 'Add a message to the queue…' : `Ask ${this.agentLabel} to do anything…`;
    this.sendBtn.title = on ? 'Queue message (Enter)' : 'Send (Enter)';
  }

  // Handle a session/update notification from the agent
  handleUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'user_message_chunk') this.currentUserMessageEl = null;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.handleAgentMessageChunk(update);
        break;
      case 'tool_call':
        this.handleToolCall(update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        break;
      case 'plan':
        this.handlePlan(update);
        break;
      case 'usage_update':
        this.handleUsageUpdate(update);
        break;
      case 'config_option_update':
        this.configOptions = update.configOptions || [];
        this.renderStatusbar();
        break;
      case 'current_mode_update': {
        const modeOption = this.configOptions.find(option => option.id === 'mode');
        if (modeOption?.type === 'select') modeOption.currentValue = update.currentModeId;
        this.renderStatusbar();
        break;
      }
      case 'available_commands_update':
        this.availableCommands = update.availableCommands || [];
        this.activeCommandIndex = 0;
        this.renderSlashCommands();
        break;
      case 'user_message_chunk':
        this.handleUserMessageChunk(update);
        break;
      case 'agent_thought_chunk':
        this.handleThoughtChunk(update);
        break;
      default:
        console.log('[ACP] Unhandled update type:', update.sessionUpdate);
    }
  }

  /**
   * ACP adapters are required to replay user_message_chunk during session/load, but several
   * currently replay only agent/tool activity. Recover locally submitted prompts from the
   * session-scoped composer history only when the adapter supplied zero user turns. This is a
   * fallback, not a second source: once adapters comply, their ordered replay wins unchanged.
   */
  restoreMissingUserPrompts(stableSessionId: string, updates: SessionUpdate[]): void {
    if (this.destroyed || this.replayUserFallbackRendered) return;
    if (updates.some(update => update.sessionUpdate === 'user_message_chunk')) return;
    const key = this.historyStorageKey(stableSessionId);
    this.promptHistoryKey = key;
    this.promptHistory = AcpPromptHistory.load(key);
    const prompts = this.promptHistory.values();
    if (prompts.length === 0) return;
    this.replayUserFallbackRendered = true;
    for (const prompt of prompts) this.addUserMessage(prompt);
  }

  async replayUpdates(updates: SessionUpdate[], batchSize = 100): Promise<void> {
    if (updates.length === 0 || this.destroyed) return;
    this.isReplayingHistory = true;
    try {
      for (let index = 0; index < updates.length && !this.destroyed; index += 1) {
        this.handleUpdate(updates[index]);
        if ((index + 1) % batchSize === 0) {
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              resolve();
            };
            const timeout = window.setTimeout(finish, 50);
            requestAnimationFrame(finish);
          });
        }
      }
    } finally {
      this.isReplayingHistory = false;
      if (!this.destroyed) this.scrollToBottom(true);
    }
  }

  // #112: read the current session status (e.g. 'prompting') so a restart can decide
  // whether to confirm interruption. Returns the last status set via handleStatus.
  getStatus(): AcpSessionInfo['status'] {
    return this.status;
  }

  handleStatus(info: Partial<AcpSessionInfo>): void {
    if (info.sessionId) {
      const stableHistoryKey = this.historyStorageKey(info.sessionId);
      if (stableHistoryKey !== this.promptHistoryKey) {
        this.promptHistoryKey = stableHistoryKey;
        this.promptHistory = AcpPromptHistory.load(this.promptHistoryKey);
      }
    }
    if (info.startupPhase) this.startupPhase = info.startupPhase;
    if (info.configOptions) this.configOptions = info.configOptions;
    if (info.promptCapabilities !== undefined) {
      this.supportsImages = Boolean(info.promptCapabilities?.image);
    }
    if (info.status) {
      this.status = info.status;
      if (info.status === 'initializing' || info.status === 'idle' || info.status === 'ready') {
        this.errorEl?.remove();
        this.errorEl = null;
      }
      if (info.status === 'prompting') this.setPrompting(true);
      else if (info.status === 'idle' || info.status === 'ready') this.setPrompting(false);
      const unavailable = info.status === 'initializing' || info.status === 'error' || info.status === 'closed';
      this.inputEl.disabled = unavailable;
      this.sendBtn.disabled = unavailable;
      if (info.status === 'initializing') this.inputEl.placeholder = `${this.startupLabel()}…`;
    }
    if (info.errorMessage) {
      this.renderSessionError(info.errorMessage);
    }
    this.renderStatusbar();
  }

  // ========== Permission prompt UI ==========
  showPermissionPrompt(toolCallId: string, toolName: string, options: PermissionOption[]): void {
    this.ensureConversationStarted();
    this.finishActivityGroup();
    const existing = this.container.querySelector('.acp-permission-prompt');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'acp-permission-prompt';
    const toolIcon = this.toolKindIcon(this.guessToolKind(toolName));
    el.innerHTML = `
      <div class="acp-perm-icon">${toolIcon}</div>
      <div class="acp-perm-body">
        <div class="acp-perm-title">${this.escapeHtml(toolName)}</div>
        <div class="acp-perm-desc">wants to run — approve?</div>
      </div>
      <div class="acp-perm-actions"></div>
    `;

    const actionsEl = this.requiredElement<HTMLElement>('.acp-perm-actions', el);
    for (const opt of options) {
      const btn = document.createElement('button');
      const kindClass = opt.kind === 'allow_always' ? 'acp-perm-allow-always'
        : opt.kind === 'allow_once' ? 'acp-perm-allow-once'
        : 'acp-perm-deny';
      btn.className = `acp-perm-btn ${kindClass}`;
      btn.textContent = opt.name;
      btn.addEventListener('click', async () => {
        el.remove();
        try {
          await window.posse.acpResolvePermission(this.sessionId, toolCallId, 'selected', opt.optionId);
        } catch (err) {
          console.error('[ACP] Failed to resolve permission:', err);
        }
      });
      actionsEl.appendChild(btn);
    }

    this.appendConversationNode(el);
    this.scrollToBottom();
  }

  // ========== Agent message rendering with Markdown ==========
  private handleUserMessageChunk(update: UserMessageChunkUpdate): void {
    // Locally submitted prompts are rendered before the ACP request starts. Some agents echo
    // them back during the live turn; only load/replay chunks should create another bubble.
    if (this.isPrompting || !update.content) return;
    const messageId = update.messageId;
    const current = this.currentUserMessageEl;
    const sameMessage = Boolean(current) && (
      (Boolean(messageId) && current?.dataset.messageId === messageId)
      || (!messageId && !current?.dataset.messageId)
    );

    if (update.content.type === 'text') {
      const text = update.content.text;
      if (sameMessage && current) {
        const raw = (current.dataset.raw || '') + text;
        current.dataset.raw = raw;
        const textEl = this.requiredElement<HTMLElement>('.acp-user-text', current);
        textEl.textContent = raw;
        this.linkifyPlainUrls(textEl, true);
        this.scrollToBottom();
        return;
      }
      this.currentUserMessageEl = this.addUserMessage(text);
    } else if (update.content.type === 'image') {
      const image: ComposerImage = {
        dataUrl: `data:${update.content.mimeType};base64,${update.content.data}`,
        name: 'Attached image',
      };
      if (sameMessage && current) {
        this.appendUserImages(current, [image]);
        this.scrollToBottom();
        return;
      }
      this.currentUserMessageEl = this.addUserMessage('', [image]);
    } else {
      return;
    }

    if (messageId) this.currentUserMessageEl.dataset.messageId = messageId;
    if (update.content.type === 'text') this.currentUserMessageEl.dataset.raw = update.content.text;
  }

  private handleAgentMessageChunk(update: AgentMessageChunkUpdate): void {
    if (!update.content || update.content.type !== 'text') return;
    const text = update.content.text;

    const messageId = update.messageId;
    const currentMessage = this.currentMessageEl;
    const sameMessage = Boolean(currentMessage) && (
      (Boolean(messageId) && currentMessage?.dataset.messageId === messageId)
      || (!messageId && !currentMessage?.dataset.messageId)
    );
    if (sameMessage && currentMessage) {
      const raw = (currentMessage.dataset.raw || '') + text;
      currentMessage.dataset.raw = raw;
      // Claude Code's adapter may replay its internal subagent completion envelope as an
      // agent_message_chunk. It is transport metadata, not assistant prose. Keep the detached
      // element as the chunk accumulator so every later chunk for the same message stays hidden.
      if (currentMessage.dataset.internalNotification === 'true' || this.isInternalTaskNotification(raw)) {
        currentMessage.dataset.internalNotification = 'true';
        currentMessage.remove();
        return;
      }
      const bodyEl = this.requiredElement<HTMLElement>('.acp-msg-body', currentMessage);
      bodyEl.innerHTML = this.renderMarkdown(raw);
      this.decorateMessageContent(bodyEl);
      this.scrollToBottom();
    } else {
      this.finishActivityGroup();
      this.currentMessageEl = this.addAgentMessage(text);
      if (messageId) this.currentMessageEl.dataset.messageId = messageId;
      this.currentMessageEl.dataset.raw = text;
      if (this.isInternalTaskNotification(text)) {
        this.currentMessageEl.dataset.internalNotification = 'true';
        this.currentMessageEl.remove();
        return;
      }
      this.decorateMessageContent(this.requiredElement('.acp-msg-body', this.currentMessageEl));
    }
  }

  private isInternalTaskNotification(raw: string): boolean {
    const text = raw.trimStart();
    return text.startsWith('<task-notification>')
      || text.startsWith('&lt;task-notification&gt;')
      || text.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]');
  }

  private decorateMessageContent(scope: HTMLElement): void {
    // Codex commonly formats development URLs as inline code. They remain URLs and
    // should use the same embedded/system-browser click path as prose links.
    this.linkifyPlainUrls(scope, true);
    for (const btn of Array.from(scope.querySelectorAll('.acp-code-copy'))) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const code = (btn as HTMLElement).dataset.code || '';
        navigator.clipboard.writeText(code).then(() => {
          (btn as HTMLElement).textContent = 'copied!';
          setTimeout(() => { (btn as HTMLElement).textContent = 'copy'; }, 1500);
        });
      });
    }
  }

  private handleThoughtChunk(update: AgentThoughtChunkUpdate): void {
    if (!update.content || update.content.type !== 'text') return;
    this.ensureConversationStarted();
    const messageId = update.messageId;
    let thought = this.currentThoughtEl;
    if (!thought || (messageId && thought.dataset.messageId !== messageId)) {
      thought = document.createElement('details');
      thought.className = 'acp-thought';
      (thought as HTMLDetailsElement).open = this.conversationPreferences.expandThoughtsByDefault;
      thought.innerHTML = `
        <summary class="acp-disclosure-summary">
          <span class="acp-disclosure-chevron" aria-hidden="true">›</span>
          <span class="acp-thought-label">Thought</span>
          <span class="acp-thought-preview"></span>
        </summary>
        <div class="acp-thought-text"></div>`;
      if (messageId) thought.dataset.messageId = messageId;
      thought.dataset.raw = '';
      this.appendActivityNode(thought);
      this.currentThoughtEl = thought;
    }
    const raw = (thought.dataset.raw || '') + update.content.text;
    thought.dataset.raw = raw;
    const thoughtText = this.requiredElement<HTMLElement>('.acp-thought-text', thought);
    // #92: collapse 3+ consecutive blank lines so thought paragraphs don't sprawl.
    thoughtText.textContent = raw.replace(/\n{3,}/g, '\n\n');
    this.linkifyPlainUrls(thoughtText, true);
    this.requiredElement<HTMLElement>('.acp-thought-preview', thought).textContent = this.singleLinePreview(raw);
    this.scrollToBottom();
  }

  private handleToolCall(update: ToolCallUpdate): void {
    this.ensureConversationStarted();
    const state: ToolCallState = {
      toolCallId: update.toolCallId,
      title: update.title || 'Tool call',
      status: update.status || 'pending',
      content: update.content,
      expanded: this.conversationPreferences.expandToolsByDefault || update.status === 'failed',
      activityGroup: this.ensureActivityGroup(),
      startedMs: Date.now(),
    };
    this.toolCalls.set(update.toolCallId, state);
    this.renderToolCall(state);
  }

  private handleToolCallUpdate(update: ToolCallProgressUpdate): void {
    const state = this.toolCalls.get(update.toolCallId);
    if (!state) return;

    const previousStatus = state.status;
    state.status = update.status || state.status;
    if (update.content) state.content = update.content;
    if (update.title) state.title = update.title;
    if (state.status === 'failed' && previousStatus !== 'failed') state.expanded = true;

    this.renderToolCall(state, true);
    if (state.activityGroup) this.updateActivityGroupSummary(state.activityGroup);
  }

  // ========== Plan rendering ==========
  private handlePlan(update: PlanUpdate): void {
    const entries: PlanEntry[] = update.entries || [];
    if (entries.length === 0) return;
    this.ensureConversationStarted();

    this.planEntries = entries;
    const completed = entries.filter(e => e.status === 'completed').length;

    if (!this.planEl || !this.planEl.isConnected) {
      this.planEl = document.createElement('div');
      this.planEl.className = 'acp-plan';
      this.appendConversationNode(this.planEl);
    }

    this.planEl.innerHTML = `
      <div class="acp-plan-header">
        <span class="acp-plan-chevron">▾</span>
        <span class="acp-plan-title">Plan</span>
        <span class="acp-plan-count">${completed}/${entries.length}</span>
      </div>
      <div class="acp-plan-items"></div>
    `;

    const itemsEl = this.requiredElement<HTMLElement>('.acp-plan-items', this.planEl);
    for (const entry of entries) {
      const item = document.createElement('div');
      const status = entry.status;
      item.className = `acp-plan-item acp-plan-${status}`;
      const checkbox = status === 'completed' ? '☑' : status === 'in_progress' ? '◐' : '☐';
      const priorityBadge = entry.priority
        ? `<span class="acp-plan-priority ${this.escapeHtml(entry.priority)}">${this.escapeHtml(entry.priority)}</span>`
        : '';
      item.innerHTML = `<span class="acp-plan-checkbox">${checkbox}</span><span class="acp-plan-text">${this.escapeHtml(entry.content)}</span>${priorityBadge}`;
      itemsEl.appendChild(item);
    }

    // Toggle collapse
    const header = this.requiredElement<HTMLElement>('.acp-plan-header', this.planEl);
    header.addEventListener('click', () => {
      if (!this.planEl) return;
      const items = this.requiredElement<HTMLElement>('.acp-plan-items', this.planEl);
      const chevron = this.requiredElement<HTMLElement>('.acp-plan-chevron', this.planEl);
      const collapsed = items.style.display === 'none';
      items.style.display = collapsed ? '' : 'none';
      chevron.textContent = collapsed ? '▾' : '▸';
    });

    this.scrollToBottom();
  }

  private handleUsageUpdate(update: UsageSessionUpdate): void {
    this.contextUsage = normalizeContextUsage(update.used, update.size);
    this.renderStatusbar();
  }

  // ========== Message helpers ==========
  private addUserMessage(text: string, images: ComposerImage[] = []): HTMLElement {
    this.ensureConversationStarted();
    this.finishActivityGroup();
    const el = document.createElement('div');
    el.className = 'acp-msg acp-msg-user';
    const body = document.createElement('div');
    body.className = 'acp-msg-body';
    if (text) {
      const textEl = document.createElement('div');
      textEl.className = 'acp-user-text';
      textEl.textContent = text;
      body.appendChild(textEl);
    }
    // Edit-and-resend affordance (#83): loads this prompt back into the composer so the user
    // can correct it and submit again. NOTE: ACP has no session-trim/rollback primitive
    // (session/fork is whole-context + experimental), so resending appends a new turn rather
    // than discarding later execution. True rollback waits on upstream ACP support.
    if (text) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'acp-msg-edit-btn';
      editBtn.title = 'Edit and resend this prompt';
      editBtn.setAttribute('aria-label', 'Edit and resend this prompt');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        this.loadTextIntoComposer(text);
      });
      body.appendChild(editBtn);
    }
    el.appendChild(body);
    this.appendUserImages(el, images);
    this.linkifyPlainUrls(body, true);
    this.appendConversationNode(el);
    this.currentMessageEl = null;
    this.scrollToBottom();
    return el;
  }

  private loadTextIntoComposer(text: string): void {
    // If a prompt is running, focus-only; don't clobber an in-flight composer draft.
    if (this.isPrompting) {
      this.addSystemMessage('Wait for the current response to finish before editing a prompt.');
      return;
    }
    this.inputEl.value = text;
    this.inputEl.focus();
    const len = text.length;
    this.inputEl.setSelectionRange(len, len);
    this.autoGrowInput();
  }

  private appendUserImages(messageEl: HTMLElement, images: ComposerImage[]): void {
    if (images.length === 0) return;
    const body = this.requiredElement<HTMLElement>('.acp-msg-body', messageEl);
    let grid = body.querySelector<HTMLElement>('.acp-msg-images');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'acp-msg-images';
      body.appendChild(grid);
    }
    for (const image of images) {
      const preview = document.createElement('img');
      preview.src = image.dataUrl;
      preview.alt = image.name;
      grid.appendChild(preview);
    }
  }

  private addAgentMessage(text: string): HTMLElement {
    this.ensureConversationStarted();
    const el = document.createElement('div');
    el.className = 'acp-msg acp-msg-agent';
    el.innerHTML = `<div class="acp-msg-body">${this.renderMarkdown(text)}</div>`;
    this.appendConversationNode(el);
    this.scrollToBottom();
    return el;
  }

  private addSystemMessage(text: string): void {
    this.ensureConversationStarted();
    const el = document.createElement('div');
    el.className = 'acp-msg-system';
    el.textContent = text;
    this.appendConversationNode(el);
    this.scrollToBottom();
  }

  private renderSessionError(message: string): void {
    this.ensureConversationStarted();
    this.errorEl?.remove();
    const el = document.createElement('div');
    el.className = 'acp-session-error';
    el.setAttribute('role', 'alert');

    const text = document.createElement('span');
    text.className = 'acp-session-error-text';
    text.textContent = `Session error: ${message}`;
    el.appendChild(text);

    if (this.retrySession && this.startupPhase !== 'ready') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'acp-session-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        retry.disabled = true;
        retry.textContent = 'Retrying…';
        void Promise.resolve(this.retrySession?.()).catch((error) => {
          if (!retry.isConnected) return;
          retry.disabled = false;
          retry.textContent = 'Retry';
          text.textContent = `Session error: ${error instanceof Error ? error.message : String(error)}`;
        });
      });
      el.appendChild(retry);
    }

    this.appendConversationNode(el);
    this.errorEl = el;
    this.scrollToBottom();
  }

  // ========== Tool call rendering ==========
  private toolCallEls = new Map<string, HTMLElement>();

  private guessToolKind(title: string): string {
    const t = title.toLowerCase();
    // Subagent / delegated-task tools (Claude Task, Codex delegate, generic agent spawn).
    // Match before file/edit so a title like "Delegate file research" still classifies as subagent.
    if (t.includes('subagent') || t.includes('sub-agent') || t.includes('delegate')
        || t.includes('sub-task') || t === 'task' || t.startsWith('task:') || t.startsWith('task ')
        || t.includes('launch agent') || t.includes('spawn agent')) {
      return 'subagent';
    }
    if (t.includes('bash') || t.includes('shell') || t.includes('exec')) return 'bash';
    if (t.includes('read') || t.includes('file')) return 'file';
    if (t.includes('write') || t.includes('edit') || t.includes('create')) return 'edit';
    if (t.includes('search') || t.includes('grep') || t.includes('find')) return 'search';
    if (t.includes('web') || t.includes('fetch') || t.includes('browse')) return 'web';
    return 'other';
  }

  private toolKindIcon(kind: string): string {
    const icons: Record<string, string> = {
      bash: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4M7 11h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      file: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h5l3 3v7H3V2z" stroke="currentColor" stroke-width="1.3"/><path d="M8 2v3h3" stroke="currentColor" stroke-width="1.3"/></svg>',
      edit: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 12l2-1 7-7-2-2-7 7-1 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
      search: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/><path d="M9 9l4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
      web: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M2 7h10M7 2c1.5 1.5 1.5 8.5 0 10M7 2c-1.5 1.5-1.5 8.5 0 10" stroke="currentColor" stroke-width="1"/></svg>',
      subagent: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="9" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="6" width="8" height="6" rx="1" fill="var(--bg-elevated, #1e1e2e)" stroke="currentColor" stroke-width="1.2"/></svg>',
      other: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/></svg>',
    };
    return icons[kind] || icons.other;
  }

  private renderToolCall(state: ToolCallState, updateOnly = false): void {
    let el = this.toolCallEls.get(state.toolCallId);
    if (!el) {
      el = document.createElement('details');
      el.className = 'acp-tool-call';
      this.toolCallEls.set(state.toolCallId, el);
      this.appendActivityNode(el, state.activityGroup);
      el.addEventListener('toggle', () => {
        state.expanded = (el as HTMLDetailsElement).open;
      });
    }

    const kind = this.guessToolKind(state.title);
    const kindIcon = this.toolKindIcon(kind);
    const isSubagent = kind === 'subagent';
    el.className = `acp-tool-call acp-tool-${state.status}${isSubagent ? ' acp-tool-subagent' : ''}`;
    (el as HTMLDetailsElement).open = state.expanded;

    const statusIcon = this.toolStatusIcon(state.status);
    const statusLabel = this.toolStatusLabel(state.status);

    // Subagent panels get a richer collapsed summary: nested-window icon, task title, live
    // elapsed, status, and a one-line latest-activity preview drawn from the tool-call content.
    // This surfaces what each delegated agent is doing without expanding it — the full structured
    // content stays available under the disclosure.
    let summaryExtras = '';
    if (isSubagent) {
      const elapsed = this.formatElapsed(state.startedMs, state.status);
      const preview = this.subagentPreview(state.content);
      summaryExtras = `
        <span class="acp-subagent-elapsed" aria-hidden="true">${this.escapeHtml(elapsed)}</span>
        <span class="acp-subagent-status acp-subagent-status-${state.status}">${statusIcon}<span class="acp-subagent-status-text">${this.escapeHtml(statusLabel)}</span></span>
        ${preview ? `<span class="acp-subagent-preview">${this.escapeHtml(preview)}</span>` : ''}`;
    }

    let contentHtml = '';
    if (state.content) {
      contentHtml = '<div class="acp-tool-content">' +
        state.content.map((c) => {
          if (c.type === 'content' && c.content?.type === 'text') {
            return `<pre><code>${this.escapeHtml(c.content.text)}</code></pre>`;
          }
          if (c.type === 'diff') {
            return `<div class="acp-tool-resource">${this.escapeHtml(c.path)}</div>`;
          }
          if (c.type === 'terminal') {
            return `<div class="acp-tool-resource">Terminal ${this.escapeHtml(c.terminalId)}</div>`;
          }
          return '';
        }).join('') + '</div>';
    }

    el.innerHTML = `
      <summary class="acp-tool-header${isSubagent ? ' acp-subagent-header' : ''}">
        <span class="acp-disclosure-chevron" aria-hidden="true">›</span>
        <span class="acp-tool-kind-icon">${kindIcon}</span>
        <span class="acp-tool-title">${this.escapeHtml(state.title)}</span>
        ${summaryExtras}
        ${!isSubagent ? `<span class="acp-tool-status-icon">${statusIcon}</span>` : ''}
      </summary>
      ${contentHtml}
    `;
    this.linkifyPlainUrls(el, true);

    this.maybeReconcileSubagentTick();
    this.scrollToBottom();
  }

  // One-line latest-activity preview for a subagent tool call: the last non-empty text chunk,
  // trimmed and clipped. Returns '' when there is nothing to show.
  private subagentPreview(content?: ToolCallContent[]): string {
    if (!content || !content.length) return '';
    let last = '';
    for (const c of content) {
      if (c.type === 'content' && c.content?.type === 'text') {
        const t = (c.content.text || '').trim();
        if (t) last = t;
      }
    }
    if (!last) return '';
    const single = last.replace(/\s+/g, ' ');
    return single.length > 140 ? single.slice(0, 140) + '…' : single;
  }

  // Human-readable elapsed for a subagent: from startedMs to now while running, frozen once
  // the call reaches a terminal status (completed/failed).
  private formatElapsed(startedMs: number | undefined, status: ToolCallStatus): string {
    if (!startedMs) return '';
    const terminal = status === 'completed' || status === 'failed';
    const end = terminal ? startedMs : Date.now();
    const ms = Math.max(0, end - startedMs);
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m ${rem}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  private toolStatusLabel(status: ToolCallStatus): string {
    switch (status) {
      case 'pending': return 'Queued';
      case 'in_progress': return 'Running';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return '';
    }
  }

  // Ensure the 1s subagent-tick runs only while at least one subagent tool call is in a
  // non-terminal state, and is stopped otherwise (no steady timer when idle).
  private maybeReconcileSubagentTick(): void {
    const hasActive = Array.from(this.toolCalls.values()).some(
      s => this.guessToolKind(s.title) === 'subagent' && (s.status === 'pending' || s.status === 'in_progress'),
    );
    if (hasActive && this.subagentTickHandle === null && !this.destroyed) {
      this.subagentTickHandle = setInterval(() => this.tickSubagentElapsed(), 1000);
    } else if (!hasActive && this.subagentTickHandle !== null) {
      clearInterval(this.subagentTickHandle);
      this.subagentTickHandle = null;
    }
  }

  // Re-render only the elapsed/status bits of still-running subagent panels. Cheaper than a full
  // renderToolCall and avoids resetting scroll/expand state on each tick.
  private tickSubagentElapsed(): void {
    if (this.destroyed) {
      if (this.subagentTickHandle !== null) { clearInterval(this.subagentTickHandle); this.subagentTickHandle = null; }
      return;
    }
    let stillActive = false;
    for (const state of this.toolCalls.values()) {
      if (this.guessToolKind(state.title) !== 'subagent') continue;
      if (state.status !== 'pending' && state.status !== 'in_progress') continue;
      stillActive = true;
      const el = this.toolCallEls.get(state.toolCallId);
      const elapsedEl = el?.querySelector<HTMLElement>('.acp-subagent-elapsed');
      if (elapsedEl) elapsedEl.textContent = this.formatElapsed(state.startedMs, state.status);
    }
    if (!stillActive && this.subagentTickHandle !== null) {
      clearInterval(this.subagentTickHandle);
      this.subagentTickHandle = null;
    }
  }

  private toolStatusIcon(status: ToolCallStatus): string {
    switch (status) {
      case 'pending': return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/></svg>';
      case 'in_progress': return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="acp-spin"><path d="M6 2a4 4 0 1 0 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      case 'completed': return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'failed': return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      default: return '';
    }
  }

  // ========== Status bar ==========
  private renderStatusbar(): void {
    const configControls = statusConfigOptions(this.configOptions);
    const configHtml = configControls.map(option => {
      const controlLabel = configControlLabel(option);
      const valueLabel = configValueLabel(option);
      const accessibleLabel = `${controlLabel}: ${valueLabel}`;
      return `
      <span class="acp-sb-divider"></span>
      <button type="button" class="acp-sb-item acp-sb-clickable" data-config-id="${this.escapeHtml(option.id)}" title="${this.escapeHtml(accessibleLabel)}" aria-label="${this.escapeHtml(accessibleLabel)}" aria-haspopup="listbox">
        <span class="acp-sb-value">${this.escapeHtml(valueLabel)}</span>
        <span class="acp-sb-caret" aria-hidden="true">▾</span>
      </button>`;
    }).join('');

    const ctxLabel = this.contextUsage?.kind === 'active'
      ? `${this.formatTokens(this.contextUsage.used)}/${this.formatTokens(this.contextUsage.size)}`
      : '';
    const ctxPct = this.contextUsage?.kind === 'active' ? this.contextUsage.percentage : 0;
    const ctxColor = ctxPct > 80 ? 'var(--status-error)' : ctxPct > 60 ? 'var(--status-warning)' : 'var(--status-success)';
    const ctxTitle = this.contextUsage?.kind === 'active'
      ? `Active context: ${this.formatTokens(this.contextUsage.used)} of ${this.formatTokens(this.contextUsage.size)} used (${Math.round(ctxPct)}%); ${this.formatTokens(this.contextUsage.remaining)} remaining`
      : this.contextUsage?.kind === 'unknown'
        ? 'Active context unavailable because the agent reported invalid usage'
        : '';
    const contextHtml = this.contextUsage?.kind === 'active'
      ? `<span class="acp-sb-divider"></span><span class="acp-sb-item acp-sb-ctx" title="${this.escapeHtml(ctxTitle)}" aria-label="${this.escapeHtml(ctxTitle)}"><div class="acp-sb-ctx-bar" aria-hidden="true"><div class="acp-sb-ctx-fill" style="width:${ctxPct}%;background:${ctxColor}"></div></div><span class="acp-sb-value">${ctxLabel}</span></span>`
      : this.contextUsage?.kind === 'unknown'
        ? `<span class="acp-sb-divider"></span><span class="acp-sb-item acp-sb-ctx acp-sb-ctx-unknown" title="${this.escapeHtml(ctxTitle)}" aria-label="${this.escapeHtml(ctxTitle)}"><span class="acp-sb-value">Context unknown</span></span>`
        : '';

    const statusLabel = this.status === 'prompting' ? 'Working' : this.status === 'error' ? 'Error' : this.status === 'idle' ? 'Ready' : this.status === 'closed' ? 'Closed' : this.startupLabel();
    const statusDot = this.status === 'prompting' ? '●' : this.status === 'error' ? '✕' : this.status === 'idle' ? '●' : '○';
    const statusColor = this.status === 'prompting' ? 'var(--status-warning)' : this.status === 'error' ? 'var(--status-error)' : this.status === 'idle' ? 'var(--status-success)' : 'var(--text-muted)';

    this.statusbarEl.innerHTML = `
      <div class="acp-sb-scroll">
        <button type="button" class="acp-composer-tool" data-composer-action="attach" title="Attach image" aria-label="Attach image">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 6.5 7.2 11.3a3 3 0 0 1-4.2-4.2l5.1-5.1a2 2 0 1 1 2.8 2.8L5.8 9.9a1 1 0 0 1-1.4-1.4l4.5-4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="acp-sb-item acp-sb-workspace" title="${this.escapeHtml(this.cwd)}">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3h4l1 1h5v6H1V3z" stroke="currentColor" stroke-width="1.2"/></svg>
          <span class="acp-sb-value">${this.escapeHtml(this.shortPath(this.cwd))}</span>
        </span>
        <span class="acp-sb-divider"></span>
        <span class="acp-sb-item acp-sb-agent">
          <span class="acp-sb-agent-dot" style="background:${this.agentColor}"></span>
          <span class="acp-sb-value">${this.escapeHtml(this.agentLabel)}</span>
        </span>
        ${configHtml}
      </div>
      <div class="acp-sb-trailing">
        ${contextHtml}
        <span class="acp-sb-status" style="color:${statusColor}" role="status" title="${statusLabel}" aria-label="${statusLabel}">${statusDot}</span>
      </div>
    `;

    this.statusbarEl.querySelector('[data-composer-action="attach"]')?.addEventListener('click', () => {
      this.imageInputEl.click();
    });

    for (const option of configControls) {
      if (option.type !== 'select') continue;
      const target = Array.from(this.statusbarEl.querySelectorAll<HTMLElement>('[data-config-id]'))
        .find(element => element.dataset.configId === option.id);
      target?.addEventListener('click', () => this.showConfigDropdown(option));
    }
  }

  private historyStorageKey(stableSessionId: string): string {
    const scope = `${this.agentLabel}\n${this.cwd}\n${stableSessionId}`;
    return `posse_acp_prompt_history:${encodeURIComponent(scope)}`;
  }

  private startupLabel(): string {
    const labels: Partial<Record<NonNullable<AcpSessionInfo['startupPhase']>, string>> = {
      'loading-adapter': 'Loading adapter',
      'spawning-adapter': 'Starting adapter',
      connecting: 'Connecting',
      'initializing-protocol': 'Initializing',
      'creating-session': 'Creating session',
      'loading-session': 'Loading history',
      'applying-config': 'Applying access',
      ready: 'Ready',
    };
    return labels[this.startupPhase || 'connecting'] || 'Connecting';
  }

  private selectOptions(opt: Extract<SessionConfigOption, { type: 'select' }>): SessionConfigSelectOption[] {
    return opt.options.flatMap(option => 'group' in option ? option.options : [option]);
  }

  private showConfigDropdown(opt: Extract<SessionConfigOption, { type: 'select' }>): void {
    const existing = this.container.querySelector('.acp-config-dropdown');
    if (existing) { existing.remove(); return; }

    const options = this.selectOptions(opt);
    if (options.length === 0) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'acp-config-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.setAttribute('aria-label', opt.name);

    for (const option of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `acp-config-option ${option.value === opt.currentValue ? 'acp-config-current' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.value === opt.currentValue ? 'true' : 'false');
      item.innerHTML = `<span class="acp-config-name">${this.escapeHtml(option.name)}</span>`;
      if (option.description) {
        item.innerHTML += `<span class="acp-config-desc">${this.escapeHtml(option.description)}</span>`;
      }
      item.addEventListener('click', async () => {
        dropdown.remove();
        if (option.value !== opt.currentValue) {
          const isModelChange = opt.id === 'model';
          const previousContextUsage = this.contextUsage;
          if (isModelChange) {
            this.contextUsage = undefined;
            this.renderStatusbar();
          }
          try {
            const updated = await window.posse.acpSetConfigOption(this.sessionId, opt.id, option.value);
            this.configOptions = updated || [];
            this.renderStatusbar();
          } catch (err) {
            if (isModelChange && this.contextUsage === undefined) {
              this.contextUsage = previousContextUsage;
              this.renderStatusbar();
            }
            this.addSystemMessage(`Failed to set ${opt.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
      dropdown.appendChild(item);
    }

    const target = Array.from(this.statusbarEl.querySelectorAll<HTMLElement>('[data-config-id]'))
      .find(element => element.dataset.configId === opt.id);
    if (target) {
      const rect = target.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.bottom = `${containerRect.height - (rect.top - containerRect.top) + 4}px`;
      dropdown.style.left = `${rect.left - containerRect.left}px`;
    }

    this.container.appendChild(dropdown);
    dropdown.querySelector<HTMLButtonElement>('.acp-config-option')?.focus();

    dropdown.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dropdown.remove();
      target?.focus();
    });

    setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node)) {
          dropdown.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 0);
  }

  // ========== Markdown rendering ==========
  private renderMarkdown(text: string): string {
    // Normalize CRLF → LF so ^/$ anchors work correctly
    let html = this.escapeHtml(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    // Code blocks: ```lang\ncode\n```  (also handle no-newline-after-fence)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const langLabel = lang ? `<span class="acp-code-lang">${lang}</span>` : '';
      return `<div class="acp-code-block"><div class="acp-code-header">${langLabel}<button class="acp-code-copy" data-code="${code}">copy</button></div><pre><code>${code}</code></pre></div>`;
    });
    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code class="acp-inline-code">$1</code>');
    // Bold: **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Links: [text](url) — only http/https
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    // Headers: ### text
    html = html.replace(/^#### (.+)$/gm, '<div class="acp-md-h4">$1</div>');
    html = html.replace(/^### (.+)$/gm, '<div class="acp-md-h3">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="acp-md-h2">$1</div>');
    html = html.replace(/^# (.+)$/gm, '<div class="acp-md-h1">$1</div>');
    // Ordered lists: 1. item
    html = html.replace(/^\d+\. (.+)$/gm, '<div class="acp-md-li">$1</div>');
    // Bullet lists: - item or * item
    html = html.replace(/^[-*] (.+)$/gm, '<div class="acp-md-li">• $1</div>');
    // Blockquotes: > text
    html = html.replace(/^&gt; (.+)$/gm, '<div class="acp-md-quote">$1</div>');
    // ACP adapters sometimes emit separator-only chunks between internal turns.
    // They carry no user-facing meaning, so do not render them as horizontal rules.
    html = html.replace(/^(-{3,}|\*{3,})$/gm, '');
    // Convert remaining newlines to <br> (but not inside block elements)
    html = html.replace(/\n/g, '<br>');
    // Clean up: <br> immediately after block-level closing tags
    html = html.replace(/(<\/div>|<hr>)<br>/g, '$1');
    html = html.replace(/<br>(<div class="acp-md-)/g, '$1');
    return html;
  }

  private linkifyPlainUrls(scope: HTMLElement, includeCode: boolean): void {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      if (parent
        && !parent.closest('a, button')
        && (includeCode || !parent.closest('code, pre'))
        && /https?:\/\//i.test(current.textContent || '')) {
        textNodes.push(current as Text);
      }
      current = walker.nextNode();
    }

    const urlPattern = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?()[\]{}]/gi;
    for (const textNode of textNodes) {
      const text = textNode.data;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let match = urlPattern.exec(text);
      while (match) {
        if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
        const link = document.createElement('a');
        link.href = match[0];
        link.rel = 'noopener';
        link.textContent = match[0];
        fragment.append(link);
        cursor = match.index + match[0].length;
        match = urlPattern.exec(text);
      }
      if (cursor === 0) continue;
      if (cursor < text.length) fragment.append(text.slice(cursor));
      textNode.replaceWith(fragment);
    }
  }

  // ========== Utilities ==========
  private isNearBottom(): boolean {
    const distance = this.scrollEl.scrollHeight - this.scrollEl.clientHeight - this.scrollEl.scrollTop;
    return distance <= BOTTOM_PROXIMITY_PX;
  }

  private updateJumpToBottomVisibility(): void {
    this.jumpToBottomBtn.hidden = this.isNearBottom();
  }

  private scrollToBottom(force = false): void {
    if (this.isReplayingHistory) return;
    if (!force && !this.followsLatest) {
      this.updateJumpToBottomVisibility();
      return;
    }
    this.followsLatest = true;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this.updateJumpToBottomVisibility();
  }

  private appendConversationNode(element: HTMLElement): void {
    this.messagesEl.insertBefore(element, this.typingIndicatorEl);
  }

  private ensureActivityGroup(): HTMLDetailsElement {
    if (this.currentActivityEl?.isConnected && this.currentActivityContentEl?.isConnected) {
      return this.currentActivityEl;
    }
    const group = document.createElement('details');
    group.className = 'acp-activity-group';
    group.open = this.conversationPreferences.expandThoughtsByDefault
      || this.conversationPreferences.expandToolsByDefault;
    group.innerHTML = `
      <summary class="acp-activity-summary">
        <span class="acp-disclosure-chevron" aria-hidden="true">›</span>
        <span class="acp-activity-title">Activity</span>
        <span class="acp-activity-count">0</span>
        <span class="acp-activity-state"></span>
      </summary>
      <div class="acp-activity-content"></div>`;
    this.appendConversationNode(group);
    this.currentActivityEl = group;
    this.currentActivityContentEl = this.requiredElement('.acp-activity-content', group);
    return group;
  }

  private appendActivityNode(element: HTMLElement, targetGroup?: HTMLDetailsElement): void {
    const group = targetGroup || this.ensureActivityGroup();
    const content = this.requiredElement<HTMLElement>('.acp-activity-content', group);
    content.appendChild(element);
    this.updateActivityGroupSummary(group);
  }

  private updateActivityGroupSummary(group: HTMLDetailsElement): void {
    const count = group.querySelectorAll('.acp-thought, .acp-tool-call').length;
    const countEl = group.querySelector<HTMLElement>('.acp-activity-count');
    const stateEl = group.querySelector<HTMLElement>('.acp-activity-state');
    if (countEl) countEl.textContent = `${count} ${count === 1 ? 'step' : 'steps'}`;
    if (!stateEl) return;
    const hasFailure = Boolean(group.querySelector('.acp-tool-failed'));
    const isRunning = Boolean(group.querySelector('.acp-tool-in_progress'));
    stateEl.className = `acp-activity-state${hasFailure ? ' acp-activity-state--failed' : isRunning ? ' acp-activity-state--running' : ''}`;
    stateEl.textContent = hasFailure ? 'Failed' : isRunning ? 'Running' : '';
    if (hasFailure) group.open = true;
  }

  private finishActivityGroup(): void {
    if (this.currentActivityEl) this.updateActivityGroupSummary(this.currentActivityEl);
    this.currentActivityEl = null;
    this.currentActivityContentEl = null;
    this.currentThoughtEl = null;
  }

  private singleLinePreview(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, 'code')
      .replace(/[*_~`#>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private shortPath(p: string): string {
    const parts = p.split('/');
    if (parts.length > 3) return '…/' + parts.slice(-2).join('/');
    return p;
  }

  private formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  private requiredElement<T extends Element>(selector: string, root: ParentNode = this.container): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`ACP view is missing required element: ${selector}`);
    return element;
  }

  private ensureConversationStarted(): void {
    this.messagesEl.querySelector('.acp-welcome')?.remove();
  }

  destroy(notifyMain = true): void {
    this.destroyed = true;
    if (this.subagentTickHandle !== null) {
      clearInterval(this.subagentTickHandle);
      this.subagentTickHandle = null;
    }
    this.messagesResizeObserver.disconnect();
    if (notifyMain) window.posse.acpDestroy(this.sessionId);
    this.container.remove();
  }
}
