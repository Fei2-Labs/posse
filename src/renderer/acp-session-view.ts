// ACP Session View — structured rendering of ACP session/update events.
// Redesigned to match mainstream agent desktop UIs (Cursor / Devin / Windsurf / Cline).
// Full-width message blocks, agent avatars, compact tool cards, modern input bar.

import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  PromptCapabilities,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  UsageUpdate,
} from '@agentclientprotocol/sdk';
import {
  AcpPromptQueue,
  configControlLabel,
  configValueLabel,
  imageContentFromDataUrl,
  statusConfigOptions,
} from './acp-session-state';
import { getAgentLogo } from './agent-logos';
import {
  DEFAULT_CONVERSATION_PREFERENCES,
  type ConversationPreferences,
} from './conversation-preferences';

type AgentMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
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
}

interface ToolCallState {
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  expanded: boolean;
  activityGroup?: HTMLDetailsElement;
}

interface ComposerImage {
  dataUrl: string;
  name: string;
}

interface QueuedPrompt {
  blocks: ContentBlock[];
  text: string;
  images: ComposerImage[];
}

// Agent brand colors for avatars
const AGENT_COLORS: Record<string, string> = {
  Claude: '#d97757',
  Codex: '#10a37f',
  Copilot: '#6366f1',
  Kiro: '#8b5cf6',
  OpenCode: '#f59e0b',
};

export class AcpSessionView {
  private container: HTMLElement;
  private scrollEl: HTMLElement;
  private messagesEl: HTMLElement;
  private inputWrapEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private attachmentsEl: HTMLElement;
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
  private currentMessageEl: HTMLElement | null = null;
  private currentThoughtEl: HTMLElement | null = null;
  private currentActivityEl: HTMLDetailsElement | null = null;
  private currentActivityContentEl: HTMLElement | null = null;
  private isPrompting = false;
  private supportsImages: boolean | null = null;
  private composerImages: ComposerImage[] = [];
  private promptQueue = new AcpPromptQueue<QueuedPrompt>();
  private usage: Pick<UsageUpdate, 'used' | 'size' | 'cost'> | undefined;
  private planEl: HTMLElement | null = null;
  private planEntries: PlanEntry[] = [];
  private typingIndicatorEl: HTMLElement;
  private conversationPreferences: ConversationPreferences;

  constructor(
    sessionId: string,
    agentLabel: string,
    cwd: string,
    conversationPreferences: ConversationPreferences = DEFAULT_CONVERSATION_PREFERENCES,
  ) {
    this.sessionId = sessionId;
    this.agentLabel = agentLabel;
    this.cwd = cwd;
    this.conversationPreferences = { ...conversationPreferences };
    const agentName = Object.keys(AGENT_COLORS).find(name => agentLabel.startsWith(name));
    this.agentColor = agentName ? AGENT_COLORS[agentName] : '#6b7280';
    this.agentLogoMarkup = agentName ? getAgentLogo(agentName)?.markup || '' : '';

    this.container = document.createElement('div');
    this.container.className = 'acp-session-view';

    const avatarContent = this.agentLogoMarkup || this.escapeHtml(agentLabel.charAt(0).toUpperCase());
    const safeAgent = this.escapeHtml(agentLabel);
    const safeCwd = this.escapeHtml(this.shortPath(cwd));

    this.container.innerHTML = `
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
      <div class="acp-composer-dock">
        <div class="acp-composer">
          <div class="acp-queue" id="acp-queue-${sessionId}" style="display:none;"></div>
          <div class="acp-attachments" id="acp-attachments-${sessionId}" style="display:none;"></div>
          <div class="acp-input-wrap" id="acp-input-wrap-${sessionId}">
            <input class="acp-image-input" id="acp-image-input-${sessionId}" type="file" accept="image/*" hidden>
            <textarea class="acp-input" id="acp-input-${sessionId}"
              placeholder="Ask ${safeAgent} to do anything…"
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
    this.messagesEl = this.requiredElement(`#acp-messages-${sessionId}`);
    this.inputWrapEl = this.requiredElement(`#acp-input-wrap-${sessionId}`);
    this.inputEl = this.requiredElement(`#acp-input-${sessionId}`);
    this.attachmentsEl = this.requiredElement(`#acp-attachments-${sessionId}`);
    this.imageInputEl = this.requiredElement(`#acp-image-input-${sessionId}`);
    this.queueEl = this.requiredElement(`#acp-queue-${sessionId}`);
    this.sendBtn = this.requiredElement(`#acp-send-${sessionId}`);
    this.cancelBtn = this.requiredElement(`#acp-cancel-${sessionId}`);
    this.statusbarEl = this.requiredElement(`#acp-statusbar-${sessionId}`);
    this.typingIndicatorEl = this.requiredElement(`#acp-typing-${sessionId}`);

    this.setupEvents();
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

    this.inputEl.addEventListener('input', () => {
      this.autoGrowInput();
    });

    this.inputEl.addEventListener('paste', (event) => this.handleImagePaste(event));
    this.imageInputEl.addEventListener('change', () => {
      const file = this.imageInputEl.files?.[0];
      if (file) this.addComposerImage(file);
      this.imageInputEl.value = '';
    });

    this.inputEl.addEventListener('keydown', (e) => {
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
    this.attachmentsEl.style.display = this.composerImages.length > 0 ? 'flex' : 'none';
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
    const text = this.inputEl.value.trim();
    if (!text && this.composerImages.length === 0) return null;

    const images = this.composerImages.slice();
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
    this.renderAttachments();
    return { blocks, text, images };
  }

  private async runPrompt(message: QueuedPrompt): Promise<void> {
    if (message.images.length > 0 && this.supportsImages === false) {
      this.addSystemMessage(`${this.agentLabel} does not advertise image prompt support.`);
      this.drainPromptQueue();
      return;
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
      case 'user_message_chunk':
        break;
      case 'agent_thought_chunk':
        this.handleThoughtChunk(update);
        break;
      default:
        console.log('[ACP] Unhandled update type:', update.sessionUpdate);
    }
  }

  handleStatus(info: Partial<AcpSessionInfo>): void {
    if (info.configOptions) this.configOptions = info.configOptions;
    if (info.promptCapabilities !== undefined) {
      this.supportsImages = Boolean(info.promptCapabilities?.image);
    }
    if (info.status) {
      this.status = info.status;
      if (info.status === 'prompting') this.setPrompting(true);
      else if (info.status === 'idle' || info.status === 'ready') this.setPrompting(false);
    }
    if (info.errorMessage) {
      this.addSystemMessage(`Session error: ${info.errorMessage}`);
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
  private handleAgentMessageChunk(update: AgentMessageChunkUpdate): void {
    if (!update.content || update.content.type !== 'text') return;
    const text = update.content.text;

    const messageId = update.messageId;
    const currentMessage = this.currentMessageEl;
    if (messageId && currentMessage?.dataset.messageId === messageId) {
      const raw = (currentMessage.dataset.raw || '') + text;
      currentMessage.dataset.raw = raw;
      const bodyEl = this.requiredElement<HTMLElement>('.acp-msg-body', currentMessage);
      bodyEl.innerHTML = this.renderMarkdown(raw);
      this.attachCopyHandlers(bodyEl);
      this.scrollToBottom();
    } else {
      this.finishActivityGroup();
      this.currentMessageEl = this.addAgentMessage(text);
      if (messageId) this.currentMessageEl.dataset.messageId = messageId;
      this.currentMessageEl.dataset.raw = text;
      this.attachCopyHandlers(this.requiredElement('.acp-msg-body', this.currentMessageEl));
    }
  }

  private attachCopyHandlers(scope: HTMLElement): void {
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
    this.requiredElement<HTMLElement>('.acp-thought-text', thought).textContent = raw;
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
    this.usage = { used: update.used, size: update.size, cost: update.cost };
    this.renderStatusbar();
  }

  // ========== Message helpers ==========
  private addUserMessage(text: string, images: ComposerImage[] = []): void {
    this.ensureConversationStarted();
    this.finishActivityGroup();
    const el = document.createElement('div');
    el.className = 'acp-msg acp-msg-user';
    const body = document.createElement('div');
    body.className = 'acp-msg-body';
    if (text) {
      const textEl = document.createElement('div');
      textEl.textContent = text;
      body.appendChild(textEl);
    }
    if (images.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'acp-msg-images';
      for (const image of images) {
        const preview = document.createElement('img');
        preview.src = image.dataUrl;
        preview.alt = image.name;
        grid.appendChild(preview);
      }
      body.appendChild(grid);
    }
    el.appendChild(body);
    this.appendConversationNode(el);
    this.currentMessageEl = null;
    this.scrollToBottom();
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

  // ========== Tool call rendering ==========
  private toolCallEls = new Map<string, HTMLElement>();

  private guessToolKind(title: string): string {
    const t = title.toLowerCase();
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
    el.className = `acp-tool-call acp-tool-${state.status}`;
    (el as HTMLDetailsElement).open = state.expanded;

    const statusIcon = this.toolStatusIcon(state.status);

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
      <summary class="acp-tool-header">
        <span class="acp-disclosure-chevron" aria-hidden="true">›</span>
        <span class="acp-tool-kind-icon">${kindIcon}</span>
        <span class="acp-tool-title">${this.escapeHtml(state.title)}</span>
        <span class="acp-tool-status-icon">${statusIcon}</span>
      </summary>
      ${contentHtml}
    `;

    this.scrollToBottom();
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
    const configHtml = configControls.map(option => `
      <span class="acp-sb-divider"></span>
      <button type="button" class="acp-sb-item acp-sb-clickable" data-config-id="${this.escapeHtml(option.id)}" title="${this.escapeHtml(configControlLabel(option))}" aria-haspopup="listbox">
        <span class="acp-sb-label">${this.escapeHtml(configControlLabel(option))}</span>
        <span class="acp-sb-value">${this.escapeHtml(configValueLabel(option))}</span>
        <span class="acp-sb-caret">▾</span>
      </button>`).join('');

    const ctxLabel = this.usage?.used && this.usage?.size
      ? `${this.formatTokens(this.usage.used)}/${this.formatTokens(this.usage.size)}`
      : '';
    const ctxPct = this.usage?.used && this.usage?.size
      ? Math.min(100, (this.usage.used / this.usage.size) * 100)
      : 0;
    const ctxColor = ctxPct > 80 ? '#ef4444' : ctxPct > 60 ? '#f59e0b' : '#22c55e';

    const statusDot = this.status === 'prompting' ? '●' : this.status === 'error' ? '✕' : this.status === 'idle' ? '●' : '○';
    const statusColor = this.status === 'prompting' ? '#f59e0b' : this.status === 'error' ? '#ef4444' : this.status === 'idle' ? '#22c55e' : '#6b7280';

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
        ${ctxLabel ? `<span class="acp-sb-divider"></span><span class="acp-sb-item acp-sb-ctx"><div class="acp-sb-ctx-bar"><div class="acp-sb-ctx-fill" style="width:${ctxPct}%;background:${ctxColor}"></div></div><span class="acp-sb-value">${ctxLabel}</span></span>` : ''}
        <span class="acp-sb-status" style="color:${statusColor}">${statusDot}</span>
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
          try {
            const updated = await window.posse.acpSetConfigOption(this.sessionId, opt.id, option.value);
            this.configOptions = updated || [];
            this.renderStatusbar();
          } catch (err) {
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
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

  // ========== Utilities ==========
  private scrollToBottom(): void {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
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

  destroy(): void {
    window.posse.acpDestroy(this.sessionId);
    this.container.remove();
  }
}
