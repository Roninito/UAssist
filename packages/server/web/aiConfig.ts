/**
 * AI configuration modal.
 *
 * Lets the user manage providers, keys, models, and global chat settings.
 */

import type { AiConfig, AiProviderConfig, AiProviderKind } from "./api.ts";
export type { AiConfig, AiProviderConfig, AiProviderKind } from "./api.ts";
import { api } from "./api.ts";
import { el } from "./render.ts";

const PROVIDER_KIND_LABELS: Record<AiProviderKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai: "OpenAI",
};

export class AiConfigPanel {
  private node: HTMLElement | undefined;
  private config: AiConfig | undefined;

  open(): void {
    void this.load();
  }

  close(): void {
    this.node?.remove();
    this.node = undefined;
  }

  private async load(): Promise<void> {
    try {
      const { config } = await api.aiConfig();
      this.config = config;
      this.render(config);
    } catch (err) {
      this.renderError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderError(message: string): void {
    const panel = el("aside", "ai-config-panel");
    panel.append(el("h2", undefined, "AI Settings"));
    panel.append(el("p", "error", message));
    const close = el("button", undefined, "Close");
    close.addEventListener("click", () => this.close());
    panel.append(close);
    this.mount(panel);
  }

  private render(config: AiConfig): void {
    const panel = el("aside", "ai-config-panel");

    const header = el("div", "panel-head");
    header.append(el("h2", undefined, "AI Settings"));
    const close = el("button", "close", "✕");
    close.title = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    header.append(close);
    panel.append(header);

    // --- Global settings
    panel.append(el("h3", undefined, "Global"));
    const settingsForm = el("form", "ai-form");
    settingsForm.addEventListener("submit", (e) => e.preventDefault());

    const systemPrompt = el("textarea");
    systemPrompt.value = config.systemPrompt;
    systemPrompt.rows = 5;
    systemPrompt.placeholder = "System prompt used for every card chat...";
    settingsForm.append(el("label", undefined, "System prompt"));
    settingsForm.append(systemPrompt);

    const maxTokens = el("input");
    maxTokens.type = "number";
    maxTokens.min = "1";
    maxTokens.value = String(config.maxTokens);
    settingsForm.append(el("label", undefined, "Max tokens"));
    settingsForm.append(maxTokens);

    const temperature = el("input");
    temperature.type = "number";
    temperature.min = "0";
    temperature.max = "2";
    temperature.step = "0.1";
    temperature.value = String(config.temperature);
    settingsForm.append(el("label", undefined, "Temperature"));
    settingsForm.append(temperature);

    const maxContext = el("input");
    maxContext.type = "number";
    maxContext.min = "1";
    maxContext.max = "500";
    maxContext.value = String(config.maxContextMessages);
    settingsForm.append(el("label", undefined, "Max context messages"));
    settingsForm.append(maxContext);

    panel.append(settingsForm);

    // --- Providers
    panel.append(el("h3", undefined, "Providers"));
    const providersHost = el("div", "providers");
    const providerCards: (() => AiProviderConfig | undefined)[] = [];

    for (const provider of config.providers) {
      const { card, read } = this.renderProvider(provider);
      providerCards.push(read);
      providersHost.append(card);
    }

    const addProvider = el("button", "secondary", "+ Add provider");
    addProvider.addEventListener("click", () => {
      const newProvider: AiProviderConfig = {
        id: crypto.randomUUID(),
        kind: "ollama",
        name: "New provider",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        enabled: true,
      };
      const { card, read } = this.renderProvider(newProvider);
      providerCards.push(read);
      providersHost.append(card);
    });
    providersHost.append(addProvider);
    panel.append(providersHost);

    // --- Active provider
    panel.append(el("h3", undefined, "Active provider"));
    const activeSelect = el("select");
    const updateActiveOptions = () => {
      activeSelect.replaceChildren();
      for (const p of config.providers) {
        const opt = el("option", undefined, p.name);
        opt.value = p.id;
        if (p.id === config.activeProviderId) opt.selected = true;
        activeSelect.append(opt);
      }
    };
    updateActiveOptions();
    panel.append(activeSelect);

    // --- Actions
    const actions = el("div", "panel-actions");
    const save = el("button", "primary", "Save");
    save.addEventListener("click", () => {
      const providers = providerCards.map((read) => read()).filter((p): p is AiProviderConfig => p !== undefined);
      const activeId = activeSelect.value;
      const next: AiConfig = {
        activeProviderId: activeId,
        providers,
        systemPrompt: systemPrompt.value,
        maxTokens: Number(maxTokens.value),
        temperature: Number(temperature.value),
        maxContextMessages: Number(maxContext.value),
      };
      void this.save(next);
    });

    const cancel = el("button", undefined, "Cancel");
    cancel.addEventListener("click", () => this.close());
    actions.append(save, cancel);
    panel.append(actions);

    this.mount(panel);
  }

  private renderProvider(provider: AiProviderConfig): {
    card: HTMLElement;
    read: () => AiProviderConfig | undefined;
  } {
    const card = el("div", "provider-card");

    const name = el("input");
    name.value = provider.name;
    card.append(el("label", undefined, "Name"));
    card.append(name);

    const kind = el("select");
    for (const k of ["ollama", "lmstudio", "openai"] as AiProviderKind[]) {
      const opt = el("option", undefined, PROVIDER_KIND_LABELS[k]);
      opt.value = k;
      if (provider.kind === k) opt.selected = true;
      kind.append(opt);
    }
    card.append(el("label", undefined, "Kind"));
    card.append(kind);

    const baseUrl = el("input");
    baseUrl.value = provider.baseUrl;
    card.append(el("label", undefined, "Base URL"));
    card.append(baseUrl);

    const model = el("input");
    model.value = provider.model;
    card.append(el("label", undefined, "Model"));
    card.append(model);

    const apiKey = el("input");
    apiKey.type = "password";
    apiKey.value = provider.apiKey ?? "";
    apiKey.placeholder = "Optional API key";
    card.append(el("label", undefined, "API key"));
    card.append(apiKey);

    const enabled = el("input");
    enabled.type = "checkbox";
    enabled.checked = provider.enabled;
    const enabledLabel = el("label", "inline", "Enabled");
    enabledLabel.append(enabled);
    card.append(enabledLabel);

    const remove = el("button", "danger", "Remove");
    remove.addEventListener("click", () => {
      card.dataset["removed"] = "true";
      card.style.display = "none";
    });
    card.append(remove);

    const read = () => {
      if (card.dataset["removed"]) return undefined;
      const trimmedName = name.value.trim();
      const trimmedBase = baseUrl.value.trim();
      const trimmedModel = model.value.trim();
      if (!trimmedName || !trimmedBase || !trimmedModel) return undefined;
      return {
        id: provider.id,
        kind: kind.value as AiProviderKind,
        name: trimmedName,
        baseUrl: trimmedBase,
        model: trimmedModel,
        apiKey: apiKey.value.trim() || undefined,
        enabled: enabled.checked,
      };
    };

    return { card, read };
  }

  private async save(next: AiConfig): Promise<void> {
    try {
      await api.putAiConfig(next);
      this.close();
    } catch (err) {
      window.alert(`Could not save AI settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private mount(panel: HTMLElement): void {
    this.close();
    this.node = panel;
    document.body.append(panel);
  }
}
