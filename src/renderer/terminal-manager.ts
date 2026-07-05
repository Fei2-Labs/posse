import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { agentColors } from "../shared/themes";

type AgentType = "devin" | "claude" | "aider" | "codex";

const agentLabels: Record<AgentType, string> = {
  devin: "Devin",
  claude: "Claude",
  aider: "Aider",
  codex: "Codex",
};

interface SessionTab {
  id: string;
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLElement;
  tabButton: HTMLElement;
  agent?: string;
}

declare global {
  interface Window {
    electronAPI: {
      createPtySession(opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string; pid: number }>;
      createAgentSession(opts: { agent: string; cols?: number; rows?: number; cwd?: string; args?: string[] }): Promise<{ id: string; pid: number; agent?: string }>;
      writePty(id: string, data: string): void;
      resizePty(id: string, cols: number, rows: number): void;
      onPtyData(cb: (id: string, data: string) => void): void;
      onPtyExit(cb: (id: string, code: number, signal?: number) => void): void;
    };
  }
}

export class TerminalManager {
  private tabs: Map<string, SessionTab> = new Map();
  private activeTab: string | null = null;
  private container!: HTMLElement;
  private tabBar!: HTMLElement;
  private picker: HTMLElement | null = null;

  init(): void {
    this.container = document.getElementById("terminal-container")!;
    this.tabBar = document.getElementById("tab-bar")!;

    // Listen for PTY data / exit
    window.electronAPI.onPtyData((id, data) => {
      const tab = this.tabs.get(id);
      if (tab) tab.terminal.write(data);
    });

    window.electronAPI.onPtyExit((id, _code) => {
      this.closeTab(id);
    });

    // Create initial session
    this.newSession();

    // "+" button → show picker
    const newTabBtn = document.getElementById("new-tab-btn")!;
    newTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePicker();
    });

    // Close picker on outside click
    document.addEventListener("click", () => this.closePicker());
  }

  // ─── Picker ────────────────────────────────────────────────────────────────

  private togglePicker(): void {
    if (this.picker) {
      this.closePicker();
      return;
    }
    this.picker = document.createElement("div");
    this.picker.className = "session-picker";

    // Shell entry
    const shellItem = this.pickerItem("Shell", "⌨", undefined);
    shellItem.addEventListener("click", () => {
      this.closePicker();
      this.newSession();
    });
    this.picker.appendChild(shellItem);

    // Agent entries
    for (const agent of Object.keys(agentLabels) as AgentType[]) {
      const color = agentColors[agent] ?? "#888";
      const item = this.pickerItem(agentLabels[agent], "●", color);
      item.addEventListener("click", () => {
        this.closePicker();
        this.newAgentSession(agent);
      });
      this.picker.appendChild(item);
    }

    // Position below the "+" button
    const btn = document.getElementById("new-tab-btn")!;
    const rect = btn.getBoundingClientRect();
    this.picker.style.left = `${rect.left}px`;
    this.picker.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(this.picker);
  }

  private pickerItem(label: string, icon: string, iconColor?: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "picker-item";
    const iconSpan = document.createElement("span");
    iconSpan.className = "picker-icon";
    iconSpan.textContent = icon;
    if (iconColor) iconSpan.style.color = iconColor;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    el.appendChild(iconSpan);
    el.appendChild(labelSpan);
    return el;
  }

  private closePicker(): void {
    if (this.picker) {
      this.picker.remove();
      this.picker = null;
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  async newSession(cwd?: string): Promise<void> {
    const cols = 80;
    const rows = 24;
    const { id } = await window.electronAPI.createPtySession({ cols, rows, cwd });
    this.createTab(id, cols, rows);
  }

  async newAgentSession(agent: AgentType, cwd?: string): Promise<void> {
    const cols = 80;
    const rows = 24;
    const { id } = await window.electronAPI.createAgentSession({ agent, cols, rows, cwd });
    this.createTab(id, cols, rows, agent);
  }

  private createTab(id: string, cols: number, rows: number, agent?: string): void {
    // --- terminal instance ---
    const term = new Terminal({
      cols,
      rows,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc" },
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    // --- DOM ---
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    pane.id = `pane-${id}`;
    this.container.appendChild(pane);
    term.open(pane);
    fit.fit();

    const tabBtn = document.createElement("button");
    tabBtn.className = "tab-btn";
    tabBtn.dataset.sessionId = id;
    tabBtn.addEventListener("click", () => this.switchTab(id));

    // Agent badge (colored dot) or shell label
    if (agent) {
      const badge = document.createElement("span");
      badge.className = "agent-badge";
      badge.style.backgroundColor = agentColors[agent] ?? "#888";
      tabBtn.appendChild(badge);

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = agentLabels[agent as AgentType] ?? agent;
      tabBtn.appendChild(label);
    } else {
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = "Shell";
      tabBtn.appendChild(label);
    }

    // Close button
    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(id);
    });
    tabBtn.appendChild(closeBtn);
    this.tabBar.insertBefore(tabBtn, document.getElementById("new-tab-btn"));

    // --- I/O ---
    term.onData((data) => window.electronAPI.writePty(id, data));
    term.onResize(({ cols, rows }) => window.electronAPI.resizePty(id, cols, rows));

    // --- Title propagation ---
    term.onTitleChange((title) => {
      const tab = this.tabs.get(id);
      if (!tab) return;
      const labelEl = tab.tabButton.querySelector(".tab-label");
      if (labelEl) labelEl.textContent = title;
    });

    const tab: SessionTab = { id, terminal: term, fit, element: pane, tabButton: tabBtn, agent };
    this.tabs.set(id, tab);
    this.switchTab(id);

    // Refit on window resize
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(pane);
  }

  private switchTab(id: string): void {
    for (const [sid, tab] of this.tabs) {
      const active = sid === id;
      tab.element.style.display = active ? "block" : "none";
      tab.tabButton.classList.toggle("active", active);
      if (active) {
        tab.fit.fit();
        tab.terminal.focus();
      }
    }
    this.activeTab = id;
  }

  private closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.terminal.dispose();
    tab.element.remove();
    tab.tabButton.remove();
    this.tabs.delete(id);

    if (this.activeTab === id) {
      const next = this.tabs.keys().next().value;
      if (next) this.switchTab(next);
    }
  }
}
