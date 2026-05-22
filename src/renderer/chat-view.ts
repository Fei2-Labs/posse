export interface ChatViewCallbacks {
  onTitleChange?: (sessionId: string, title: string) => void;
}

export class ChatView {
  private container: HTMLElement;
  private sessionId: string;
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private modelSelect: HTMLSelectElement;
  private callbacks: ChatViewCallbacks;
  private currentStreamEl: HTMLElement | null = null;
  private currentStreamText: string = '';
  private cleanupFns: Array<() => void> = [];

  constructor(container: HTMLElement, sessionId: string, callbacks: ChatViewCallbacks = {}) {
    this.container = container;
    this.sessionId = sessionId;
    this.callbacks = callbacks;

    this.container.className = 'chat-view-container';
    this.container.innerHTML = `
      <div class="chat-messages" id="chat-messages-${sessionId}"></div>
      <div class="chat-input-area">
        <div class="chat-input-top">
          <select class="chat-model-select" id="chat-model-${sessionId}">
            <option value="">默认模型</option>
          </select>
          <span class="chat-slash-hint">/auto-login /health /models /clear</span>
        </div>
        <div class="chat-input-row">
          <textarea class="chat-input" id="chat-input-${sessionId}" rows="1" placeholder="输入消息或 / 命令..." enterkeyhint="send"></textarea>
          <button class="chat-send-btn" id="chat-send-${sessionId}">发送</button>
        </div>
      </div>
    `;

    this.messagesEl = this.container.querySelector(`#chat-messages-${sessionId}`)!;
    this.inputEl = this.container.querySelector(`#chat-input-${sessionId}`)!;
    this.sendBtn = this.container.querySelector(`#chat-send-${sessionId}`)!;
    this.modelSelect = this.container.querySelector(`#chat-model-${sessionId}`)!;

    this.setupEvents();
    this.loadModels();
    this.loadMessages();
    this.setupIPCListeners();
  }

  private setupEvents(): void {
    this.sendBtn.addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });
  }

  private setupIPCListeners(): void {
    const d = window.duocli;

    const onDelta = (sessionId: string, text: string) => {
      if (sessionId !== this.sessionId) return;
      this.appendStreamText(text);
    };
    d.onChatDelta(onDelta);
    this.cleanupFns.push(() => { /* listener persists, cleaned in destroy */ });

    const onDone = (sessionId: string, content: string) => {
      if (sessionId !== this.sessionId) return;
      this.finishStream(content);
    };
    d.onChatDone(onDone);

    const onError = (sessionId: string, error: string) => {
      if (sessionId !== this.sessionId) return;
      this.finishStreamError(error);
    };
    d.onChatError(onError);

    const onTitleUpdate = (sessionId: string, title: string) => {
      if (sessionId !== this.sessionId) return;
      this.callbacks.onTitleChange?.(sessionId, title);
    };
    d.onChatTitleUpdate(onTitleUpdate);
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await window.duocli.chatModels();
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.id} (${m.credits})`;
        this.modelSelect.appendChild(opt);
      }
    } catch { /* proxy not available */ }
  }

  private async loadMessages(): Promise<void> {
    try {
      const messages = await window.duocli.chatMessages(this.sessionId);
      for (const msg of messages) {
        this.addBubble(msg.role, msg.content);
      }
      this.scrollToBottom();
    } catch { /* ignore */ }
  }

  private addBubble(role: string, content: string, isStreaming = false): HTMLElement {
    const el = document.createElement('div');
    el.className = `chat-bubble chat-bubble-${role}${isStreaming ? ' streaming' : ''}`;

    const label = document.createElement('div');
    label.className = 'chat-bubble-label';
    if (role === 'user') {
      label.textContent = 'YOU';
    } else if (role === 'assistant') {
      label.textContent = 'AI';
    } else if (role === 'system') {
      label.textContent = 'SYS';
      label.classList.add('chat-bubble-label-system');
    }
    el.appendChild(label);

    const body = document.createElement('div');
    body.className = 'chat-bubble-body';

    if (role === 'system') {
      body.classList.add('chat-bubble-system');
    }

    const text = document.createElement('div');
    text.className = 'chat-bubble-text';
    text.textContent = content;
    body.appendChild(text);

    el.appendChild(body);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  private appendStreamText(text: string): void {
    if (!this.currentStreamEl) {
      this.currentStreamEl = this.addBubble('assistant', '', true);
      this.currentStreamText = '';
    }
    this.currentStreamText += text;
    const textEl = this.currentStreamEl.querySelector('.chat-bubble-text')!;
    textEl.textContent = this.currentStreamText;
    this.scrollToBottom();
  }

  private finishStream(_content: string): void {
    if (this.currentStreamEl) {
      this.currentStreamEl.classList.remove('streaming');
    }
    this.currentStreamEl = null;
    this.currentStreamText = '';
  }

  private finishStreamError(error: string): void {
    if (this.currentStreamEl) {
      this.currentStreamEl.classList.remove('streaming');
      this.currentStreamEl.querySelector('.chat-bubble-text')!.textContent += `\n\n❌ ${error}`;
    }
    this.currentStreamEl = null;
    this.currentStreamText = '';
  }

  send(): void {
    const content = this.inputEl.value.trim();
    if (!content) return;

    this.addBubble('user', content);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    window.duocli.chatSend(this.sessionId, content);
  }

  scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  focus(): void {
    this.inputEl.focus();
  }

  destroy(): void {
    this.container.innerHTML = '';
    this.container.className = '';
  }
}
