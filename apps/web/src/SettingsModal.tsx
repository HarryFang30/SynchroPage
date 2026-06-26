import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  Box,
  Cloud,
  Database,
  FileText,
  FolderOpen,
  KeyRound,
  Palette,
  Plus,
  RefreshCcw,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  UserCircle,
  Wrench,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { getAppCopy } from "./i18n";
import type { ModelApiConfig, ModelApiProvider, ModelRef, UiPreferences } from "./settings";

type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";

export type SettingsSection =
  | "general"
  | "providers"
  | "models"
  | "appearance"
  | "agent"
  | "pdf"
  | "account"
  | "storage"
  | "advanced";

type SaveStatusKind = "draft" | "saving" | "saved" | "error" | "quota";
type PersistentStorageState = "unknown" | "persisted" | "best-effort" | "unsupported";
type SettingsButtonVariant = "secondary" | "primary" | "destructive-outline" | "destructive-ghost";

type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  preferences: UiPreferences;
  onPreferenceChange: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
  modelApiConfig: ModelApiConfig;
  modelApiStatus: string;
  onModelApiConfigChange: (next: ModelApiConfig | ((current: ModelApiConfig) => ModelApiConfig)) => void;
  onSaveModelApiConfig: (config?: ModelApiConfig) => Promise<ModelApiConfig>;
  onFetchProviderModels: (provider: ModelApiProvider) => Promise<string[]>;
  onResetLayout: () => void;
  onResetPreferences: () => void;
  onConnectOAuth: () => void;
  oauthMode: OAuthMode;
  oauthAccount: string | null;
  providerStatus: string;
  jobStatus: string;
  documentTitle: string;
  saveState: { kind: SaveStatusKind; message?: string; updatedAt?: number };
  storageEstimate: { usage: number; quota: number; workspaceCount: number; documentCount: number } | null;
  persistentStorageState: PersistentStorageState;
  desktopStorageConfig: SynchroPageDesktopStorageConfig | null;
  desktopStorageBusy: boolean;
  hasWorkspace: boolean;
  onRequestPersistentStorage: () => void;
  onChooseDesktopDataDirectory: () => void;
  onResetDesktopDataDirectory: () => void;
  onRestartDesktopApp: () => void;
  onExportWorkspace: () => void;
  onImportWorkspace: () => void;
  onClearWorkspace: () => void;
  onRepairStorage: () => void;
  onResetWorkspace: () => void;
};

export function SettingsModal(props: SettingsModalProps) {
  const section = props.activeSection;
  const copy = getAppCopy(props.preferences.language);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const sections: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
    { id: "general", label: copy.settings.sections.general, icon: <Settings2 /> },
    { id: "providers", label: copy.settings.sections.providers, icon: <Cloud /> },
    { id: "models", label: copy.settings.sections.models, icon: <Box /> },
    { id: "appearance", label: copy.settings.sections.appearance, icon: <Palette /> },
    { id: "agent", label: copy.settings.sections.agent, icon: <Bot /> },
    { id: "pdf", label: copy.settings.sections.pdf, icon: <FileText /> },
    { id: "account", label: copy.settings.sections.account, icon: <UserCircle /> },
    { id: "storage", label: copy.settings.sections.storage, icon: <Database /> },
    { id: "advanced", label: copy.settings.sections.advanced, icon: <Wrench /> },
  ];

  const requestConfirm = (action: ConfirmAction) => setConfirmAction(action);
  const confirmAndClose = () => {
    const action = confirmAction;
    setConfirmAction(null);
    action?.onConfirm();
  };

  return (
    <>
      <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="settings-overlay" />
          <Dialog.Content className="settings-dialog" aria-describedby="settings-description">
          <div className="settings-sidebar">
            <Dialog.Close className="settings-close" aria-label={copy.settings.close}>
              <X />
            </Dialog.Close>
            <nav className="settings-nav" aria-label={copy.settings.navAria}>
              {sections.map((item) => (
                <button
                  className={`settings-nav-item ${section === item.id ? "active" : ""}`}
                  key={item.id}
                  type="button"
                  onClick={() => props.onSectionChange(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="settings-content">
            <div className="settings-content-header">
              <Dialog.Title>{sections.find((item) => item.id === section)?.label}</Dialog.Title>
              <Dialog.Description id="settings-description">
                {copy.settings.description}
              </Dialog.Description>
            </div>
            <div className="settings-panel">
              {section === "general" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.general.languageLabel} description={copy.settings.general.languageDescription}>
                    <SettingsSelect
                      value={props.preferences.language}
                      onChange={(value) => props.onPreferenceChange("language", value as UiPreferences["language"])}
                      options={[
                        ["zh-CN", copy.settings.general.chinese],
                        ["en-US", copy.settings.general.english],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.general.savePreferencesLabel} description={copy.settings.general.savePreferencesDescription}>
                    <SettingsSwitch
                      checked={props.preferences.autoSaveSession}
                      onCheckedChange={(checked) => props.onPreferenceChange("autoSaveSession", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.general.resetLayoutLabel} description={copy.settings.general.resetLayoutDescription}>
                    <SettingsButton onClick={props.onResetLayout}>{copy.settings.general.resetLayoutButton}</SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "providers" && (
                <ProviderSettingsPanel
                  config={props.modelApiConfig}
                  status={props.modelApiStatus}
                  onChange={props.onModelApiConfigChange}
                  onSave={props.onSaveModelApiConfig}
                  onFetchModels={props.onFetchProviderModels}
                />
              )}

              {section === "models" && (
                <DefaultModelSettingsPanel
                  config={props.modelApiConfig}
                  status={props.modelApiStatus}
                  onChange={props.onModelApiConfigChange}
                  onSave={props.onSaveModelApiConfig}
                />
              )}

              {section === "appearance" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.appearance.themeLabel} description={copy.settings.appearance.themeDescription}>
                    <SettingsSelect
                      value={props.preferences.theme}
                      onChange={(value) => props.onPreferenceChange("theme", value as UiPreferences["theme"])}
                      options={[
                        ["system", copy.settings.appearance.themeSystem],
                        ["light", copy.settings.appearance.themeLight],
                        ["dark", copy.settings.appearance.themeDark],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.appearance.accentLabel} description={copy.settings.appearance.accentDescription}>
                    <SettingsSelect
                      value={props.preferences.accentColor}
                      onChange={(value) => props.onPreferenceChange("accentColor", value as UiPreferences["accentColor"])}
                      options={[
                        ["clay", copy.settings.appearance.accentClay],
                        ["graphite", copy.settings.appearance.accentGraphite],
                        ["sage", copy.settings.appearance.accentSage],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.appearance.pdfBackgroundLabel} description={copy.settings.appearance.pdfBackgroundDescription}>
                    <SettingsSelect
                      value={props.preferences.pdfBackground}
                      onChange={(value) => props.onPreferenceChange("pdfBackground", value as UiPreferences["pdfBackground"])}
                      options={[
                        ["paper", copy.settings.appearance.pdfBackgroundPaper],
                        ["plain", copy.settings.appearance.pdfBackgroundPlain],
                        ["soft", copy.settings.appearance.pdfBackgroundSoft],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.appearance.fontScaleLabel} description={copy.settings.appearance.fontScaleDescription}>
                    <SettingsSelect
                      value={props.preferences.fontScale}
                      onChange={(value) => props.onPreferenceChange("fontScale", value as UiPreferences["fontScale"])}
                      options={[
                        ["compact", copy.settings.appearance.fontCompact],
                        ["default", copy.settings.appearance.fontDefault],
                        ["large", copy.settings.appearance.fontLarge],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.appearance.compactModeLabel} description={copy.settings.appearance.compactModeDescription}>
                    <SettingsSwitch
                      checked={props.preferences.compactMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("compactMode", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "agent" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.agent.sourcePillsLabel} description={copy.settings.agent.sourcePillsDescription}>
                    <SettingsSwitch
                      checked={props.preferences.showSourcePills}
                      onCheckedChange={(checked) => props.onPreferenceChange("showSourcePills", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.pageSuggestionsLabel} description={copy.settings.agent.pageSuggestionsDescription}>
                    <SettingsSwitch
                      checked={props.preferences.pageAwareSuggestions}
                      onCheckedChange={(checked) => props.onPreferenceChange("pageAwareSuggestions", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.explanationLanguageLabel} description={copy.settings.agent.explanationLanguageDescription}>
                    <SettingsSelect
                      value={props.preferences.explanationLanguage}
                      onChange={(value) => props.onPreferenceChange("explanationLanguage", value as UiPreferences["explanationLanguage"])}
                      options={[
                        ["auto", copy.settings.agent.explanationLanguageAuto],
                        ["zh-CN", copy.settings.agent.explanationLanguageChinese],
                        ["en-US", copy.settings.agent.explanationLanguageEnglish],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.answerModeLabel} description={copy.settings.agent.answerModeDescription}>
                    <SettingsSelect
                      value={props.preferences.agentAnswerMode}
                      onChange={(value) => props.onPreferenceChange("agentAnswerMode", value as UiPreferences["agentAnswerMode"])}
                      options={[
                        ["concise", copy.settings.agent.answerModeConcise],
                        ["guided", copy.settings.agent.answerModeGuided],
                        ["detailed", copy.settings.agent.answerModeDetailed],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.modelReasoningEffortLabel} description={copy.settings.agent.modelReasoningEffortDescription}>
                    <SettingsSelect
                      value={props.preferences.modelReasoningEffort}
                      onChange={(value) => props.onPreferenceChange("modelReasoningEffort", value as UiPreferences["modelReasoningEffort"])}
                      options={[
                        ["none", copy.settings.agent.reasoningEffortNone],
                        ["low", copy.settings.agent.reasoningEffortLow],
                        ["medium", copy.settings.agent.reasoningEffortMedium],
                        ["high", copy.settings.agent.reasoningEffortHigh],
                        ["xhigh", copy.settings.agent.reasoningEffortXHigh],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.pdfContextFullPageLimitLabel} description={copy.settings.agent.pdfContextFullPageLimitDescription}>
                    <SettingsNumberInput
                      value={props.preferences.pdfContextFullPageLimit}
                      min={1}
                      max={500}
                      onChange={(value) => props.onPreferenceChange("pdfContextFullPageLimit", value)}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.agent.pdfContextEdgePageCountLabel} description={copy.settings.agent.pdfContextEdgePageCountDescription}>
                    <SettingsNumberInput
                      value={props.preferences.pdfContextEdgePageCount}
                      min={1}
                      max={100}
                      onChange={(value) => props.onPreferenceChange("pdfContextEdgePageCount", value)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "pdf" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.pdf.scrollbarLabel} description={copy.settings.pdf.scrollbarDescription}>
                    <SettingsSelect
                      value={props.preferences.scrollbarStyle}
                      onChange={(value) => props.onPreferenceChange("scrollbarStyle", value as UiPreferences["scrollbarStyle"])}
                      options={[
                        ["thin", copy.settings.pdf.scrollbarThin],
                        ["subtle", copy.settings.pdf.scrollbarSubtle],
                        ["native", copy.settings.pdf.scrollbarNative],
                      ]}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "account" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.account.oauthStatusLabel} description={copy.settings.account.oauthStatusDescription}>
                    <StatusValue>{oauthStatusLabel(props.oauthMode, copy)}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.account.connectedEmailLabel} description={copy.settings.account.connectedEmailDescription}>
                    <StatusValue>{props.oauthAccount || copy.settings.account.notConnected}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.account.providerStatusLabel} description={props.documentTitle}>
                    <StatusValue>{props.providerStatus}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.account.reconnectLabel} description={copy.settings.account.reconnectDescription}>
                    <SettingsButton
                      variant={props.oauthMode === "connected" ? "destructive-outline" : "secondary"}
                      onClick={() => {
                        if (props.oauthMode !== "connected") {
                          props.onConnectOAuth();
                          return;
                        }
                        requestConfirm({
                          title: copy.settings.confirm.disconnectTitle,
                          description: copy.settings.confirm.disconnectDescription,
                          confirmLabel: copy.settings.confirm.disconnectConfirm,
                          onConfirm: props.onConnectOAuth,
                        });
                      }}
                    >
                      {props.oauthMode === "connected" ? copy.settings.account.disconnectButton : copy.settings.account.connectButton}
                    </SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "storage" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.storage.saveStateLabel} description={copy.settings.storage.saveStateDescription}>
                    <StatusValue>{props.saveState.message || saveKindLabel(props.saveState.kind, copy)}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.workspaceCountLabel} description={copy.settings.storage.workspaceCountDescription}>
                    <StatusValue>{props.storageEstimate?.workspaceCount ?? 0}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.documentCountLabel} description={copy.settings.storage.documentCountDescription}>
                    <StatusValue>{props.storageEstimate?.documentCount ?? 0}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.usageLabel} description={copy.settings.storage.usageDescription}>
                    <StatusValue>
                      {formatBytes(props.storageEstimate?.usage || 0)}
                      {props.storageEstimate?.quota ? ` / ${formatBytes(props.storageEstimate.quota)}` : ""}
                    </StatusValue>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.persistentLabel} description={copy.settings.storage.persistentDescription}>
                    <div className="settings-inline-actions">
                      <StatusValue>{persistentStatusLabel(props.persistentStorageState, copy)}</StatusValue>
                      <SettingsButton
                        disabled={props.persistentStorageState === "persisted" || props.persistentStorageState === "unsupported"}
                        onClick={props.onRequestPersistentStorage}
                      >
                        {copy.settings.storage.persistentRequestButton}
                      </SettingsButton>
                    </div>
                  </SettingsRow>
                  <SettingsRow className="settings-row-directory" label={copy.settings.storage.dataDirectoryLabel} description={copy.settings.storage.dataDirectoryDescription}>
                    <div className="settings-directory-control">
                      <div className="settings-directory-paths">
                        {props.desktopStorageConfig ? (
                          <div className="settings-directory-path-row">
                            <span className="settings-directory-caption">{copy.settings.storage.currentDataDirectory}</span>
                            <code title={props.desktopStorageConfig.currentDataDir || copy.settings.storage.defaultDirectory}>
                              {props.desktopStorageConfig.currentDataDir || copy.settings.storage.defaultDirectory}
                            </code>
                          </div>
                        ) : (
                          <span className="settings-directory-caption">{copy.settings.storage.dataDirectoryBrowserManaged}</span>
                        )}
                        {props.desktopStorageConfig?.pendingDataDir && (
                          <div className="settings-directory-path-row pending">
                            <span className="settings-directory-caption">{copy.settings.storage.pendingDataDirectoryLabel}</span>
                            <code title={props.desktopStorageConfig.pendingDataDir}>{props.desktopStorageConfig.pendingDataDir}</code>
                          </div>
                        )}
                        {props.desktopStorageConfig?.dataDirManagedByEnv && (
                          <span className="settings-directory-pending">{copy.settings.storage.dataDirectoryManagedByEnv}</span>
                        )}
                      </div>
                      <div className="settings-directory-actions">
                        <SettingsButton
                          disabled={!props.desktopStorageConfig || props.desktopStorageBusy || props.desktopStorageConfig.dataDirManagedByEnv}
                          onClick={props.onChooseDesktopDataDirectory}
                        >
                          <FolderOpen />
                          {copy.settings.storage.chooseDataDirectoryButton}
                        </SettingsButton>
                        <SettingsButton
                          disabled={!props.desktopStorageConfig || props.desktopStorageBusy || props.desktopStorageConfig.dataDirManagedByEnv}
                          onClick={props.onResetDesktopDataDirectory}
                        >
                          <RotateCcw />
                          {copy.settings.storage.resetDataDirectoryButton}
                        </SettingsButton>
                        {props.desktopStorageConfig?.restartRequired && (
                          <SettingsButton variant="primary" disabled={props.desktopStorageBusy} onClick={props.onRestartDesktopApp}>
                            <RefreshCcw />
                            {copy.settings.storage.restartButton}
                          </SettingsButton>
                        )}
                      </div>
                    </div>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.exportLabel} description={copy.settings.storage.exportDescription}>
                    <SettingsButton disabled={!props.hasWorkspace} onClick={props.onExportWorkspace}>
                      {copy.settings.storage.exportButton}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.importLabel} description={copy.settings.storage.importDescription}>
                    <SettingsButton onClick={props.onImportWorkspace}>{copy.settings.storage.importButton}</SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.clearLabel} description={copy.settings.storage.clearDescription}>
                    <SettingsButton
                      disabled={!props.hasWorkspace}
                      variant="destructive-outline"
                      onClick={() => requestConfirm({
                        title: copy.settings.confirm.clearWorkspaceTitle,
                        description: copy.settings.confirm.clearWorkspaceDescription,
                        confirmLabel: copy.settings.confirm.clearWorkspaceConfirm,
                        onConfirm: props.onClearWorkspace,
                      })}
                    >
                      {copy.settings.storage.clearButton}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.repairLabel} description={copy.settings.storage.repairDescription}>
                    <SettingsButton onClick={props.onRepairStorage}>{copy.settings.storage.repairButton}</SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.storage.resetLabel} description={copy.settings.storage.resetDescription}>
                    <SettingsButton
                      disabled={!props.hasWorkspace}
                      variant="destructive-outline"
                      onClick={() => requestConfirm({
                        title: copy.settings.confirm.resetWorkspaceTitle,
                        description: copy.settings.confirm.resetWorkspaceDescription,
                        confirmLabel: copy.settings.confirm.resetWorkspaceConfirm,
                        onConfirm: props.onResetWorkspace,
                      })}
                    >
                      {copy.settings.storage.resetButton}
                    </SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "advanced" && (
                <SettingsGroup>
                  <SettingsRow label={copy.settings.advanced.debugLabel} description={copy.settings.advanced.debugDescription}>
                    <SettingsSwitch
                      checked={props.preferences.debugMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("debugMode", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label={copy.settings.advanced.clearPreferencesLabel} description={copy.settings.advanced.clearPreferencesDescription}>
                    <SettingsButton
                      variant="destructive-ghost"
                      onClick={() => requestConfirm({
                        title: copy.settings.confirm.resetPreferencesTitle,
                        description: copy.settings.confirm.resetPreferencesDescription,
                        confirmLabel: copy.settings.confirm.resetPreferencesConfirm,
                        onConfirm: props.onResetPreferences,
                      })}
                    >
                      {copy.settings.advanced.clearPreferencesButton}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={copy.settings.advanced.diagnosticsLabel} description={props.preferences.debugMode ? props.jobStatus : copy.settings.advanced.diagnosticsHiddenDescription}>
                    <StatusValue>{props.preferences.debugMode ? copy.settings.advanced.visible : copy.settings.advanced.hidden}</StatusValue>
                  </SettingsRow>
                </SettingsGroup>
              )}
            </div>
          </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(confirmAction)} onOpenChange={(open) => {
        if (!open) setConfirmAction(null);
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="settings-confirm-overlay" />
          <Dialog.Content className="settings-confirm-dialog" aria-describedby="settings-confirm-description">
            <Dialog.Title>{confirmAction?.title}</Dialog.Title>
            <Dialog.Description id="settings-confirm-description">
              {confirmAction?.description}
            </Dialog.Description>
            <div className="settings-confirm-actions">
              <SettingsButton onClick={() => setConfirmAction(null)}>{copy.settings.confirm.cancel}</SettingsButton>
              <SettingsButton variant="destructive-outline" onClick={confirmAndClose}>
                {confirmAction?.confirmLabel}
              </SettingsButton>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

type ModelDefaultKey = "assistant" | "teachingFast" | "teachingBalanced" | "teachingQuality";

function ProviderSettingsPanel(props: {
  config: ModelApiConfig;
  status: string;
  onChange: (next: ModelApiConfig | ((current: ModelApiConfig) => ModelApiConfig)) => void;
  onSave: (config?: ModelApiConfig) => Promise<ModelApiConfig>;
  onFetchModels: (provider: ModelApiProvider) => Promise<string[]>;
}) {
  const [selectedProviderId, setSelectedProviderId] = useState(props.config.selectedProviderId);
  const [panelStatus, setPanelStatus] = useState("");
  const selectedProvider =
    props.config.providers.find((provider) => provider.id === selectedProviderId) ||
    props.config.providers.find((provider) => provider.id === props.config.selectedProviderId) ||
    props.config.providers[0];

  const updateProvider = (patch: Partial<ModelApiProvider>) => {
    if (!selectedProvider) return;
    props.onChange((current) => ({
      ...current,
      selectedProviderId: selectedProvider.id,
      providers: current.providers.map((provider) => provider.id === selectedProvider.id ? { ...provider, ...patch } : provider),
    }));
  };
  const addProvider = () => {
    const id = `provider_${Date.now().toString(36)}`;
    const provider: ModelApiProvider = {
      id,
      name: "Custom Provider",
      type: "openai-compatible",
      apiHost: "https://api.example.com",
      apiKeyRequired: true,
      enabled: false,
      models: ["custom-model"],
    };
    props.onChange((current) => ({
      ...current,
      selectedProviderId: id,
      providers: [...current.providers, provider],
    }));
    setSelectedProviderId(id);
  };
  const removeProvider = () => {
    if (!selectedProvider || selectedProvider.type === "codex-oauth") return;
    props.onChange((current) => {
      const providers = current.providers.filter((provider) => provider.id !== selectedProvider.id);
      const nextProviderId = providers[0]?.id || "codex_oauth";
      return {
        ...current,
        selectedProviderId: nextProviderId,
        providers,
      };
    });
    setSelectedProviderId(props.config.providers[0]?.id || "codex_oauth");
  };
  const fetchModels = async () => {
    if (!selectedProvider) return;
    setPanelStatus("Fetching models...");
    try {
      const models = await props.onFetchModels(selectedProvider);
      updateProvider({ models, enabled: true });
      setPanelStatus(`Fetched ${models.length} models`);
    } catch (error) {
      setPanelStatus((error as Error).message || "Model fetch failed");
    }
  };
  const save = async () => {
    setPanelStatus("Saving...");
    try {
      await props.onSave();
      setPanelStatus("Saved");
    } catch (error) {
      setPanelStatus((error as Error).message || "Save failed");
    }
  };

  if (!selectedProvider) return null;
  return (
    <div className="settings-provider-panel">
      <div className="settings-provider-list">
        <div className="settings-provider-list-header">
          <span>Providers</span>
          <SettingsIconButton label="Add provider" onClick={addProvider}>
            <Plus />
          </SettingsIconButton>
        </div>
        <div className="settings-provider-list-items">
          {props.config.providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`settings-provider-item ${selectedProvider.id === provider.id ? "active" : ""}`}
              onClick={() => {
                setSelectedProviderId(provider.id);
                props.onChange((current) => ({ ...current, selectedProviderId: provider.id }));
              }}
            >
              <span className="settings-provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{provider.name}</strong>
                <small>{provider.enabled ? "Enabled" : "Disabled"}</small>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-provider-detail">
        <div className="settings-provider-detail-header">
          <div>
            <h3>{selectedProvider.name}</h3>
            <p>{providerPreviewUrl(selectedProvider)}</p>
          </div>
          <SettingsSwitch checked={selectedProvider.enabled} onCheckedChange={(enabled) => updateProvider({ enabled })} />
        </div>

        <SettingsGroup>
          <SettingsRow label="Provider name" description="Shown in model selectors and request status.">
            <SettingsTextInput value={selectedProvider.name} onChange={(name) => updateProvider({ name })} />
          </SettingsRow>
          <SettingsRow label="API type" description="Use Chat Completions for most OpenAI-compatible providers.">
            <SettingsSelect
              value={selectedProvider.type}
              onChange={(type) => updateProvider({
                type: type as ModelApiProvider["type"],
                apiKeyRequired: type !== "codex-oauth",
              })}
              options={[
                ["codex-oauth", "OpenAI OAuth"],
                ["openai-compatible", "OpenAI-compatible Chat"],
                ["openai-responses", "OpenAI Responses"],
              ]}
            />
          </SettingsRow>
          <SettingsRow label="API Key" description={selectedProvider.hasApiKey ? "A key is saved on the backend. Leave blank to keep it." : "Stored by the local backend model config."}>
            <div className="settings-secret-control">
              <KeyRound />
              <input
                className="settings-text-input"
                type="password"
                value={selectedProvider.apiKey || ""}
                placeholder={selectedProvider.hasApiKey ? "Saved, leave blank to keep" : "sk-..."}
                onChange={(event) => updateProvider({ apiKey: event.target.value || undefined })}
                disabled={selectedProvider.type === "codex-oauth"}
              />
            </div>
          </SettingsRow>
          <SettingsRow label="API Host" description="Preview follows the selected API type.">
            <SettingsTextInput
              value={selectedProvider.apiHost}
              onChange={(apiHost) => updateProvider({ apiHost })}
              disabled={selectedProvider.type === "codex-oauth"}
            />
          </SettingsRow>
          <SettingsRow label="Models" description="Comma or newline separated. Fetching replaces this list.">
            <SettingsTextArea value={selectedProvider.models.join("\n")} onChange={(value) => updateProvider({ models: splitModels(value) })} />
          </SettingsRow>
          <SettingsRow label="Actions" description={panelStatus || props.status}>
            <div className="settings-inline-actions">
              <SettingsButton onClick={() => void fetchModels()}>
                <RefreshCw />
                Fetch models
              </SettingsButton>
              <SettingsButton variant="primary" onClick={() => void save()}>Save</SettingsButton>
              <SettingsIconButton disabled={selectedProvider.type === "codex-oauth"} label="Delete provider" onClick={removeProvider}>
                <Trash2 />
              </SettingsIconButton>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </div>
    </div>
  );
}

function DefaultModelSettingsPanel(props: {
  config: ModelApiConfig;
  status: string;
  onChange: (next: ModelApiConfig | ((current: ModelApiConfig) => ModelApiConfig)) => void;
  onSave: (config?: ModelApiConfig) => Promise<ModelApiConfig>;
}) {
  const [panelStatus, setPanelStatus] = useState("");
  const rows: Array<{ key: ModelDefaultKey; label: string; description: string }> = [
    { key: "assistant", label: "Default Assistant Model", description: "Used by the right-side Q&A assistant." },
    { key: "teachingQuality", label: "Quality Notes Model", description: "Used for sparse, visual, or retry-heavy PDF pages." },
    { key: "teachingBalanced", label: "Balanced Notes Model", description: "Used for formula, table, and medium-complexity pages." },
    { key: "teachingFast", label: "Quick Notes Model", description: "Used for dense text pages and batch generation." },
  ];
  const updateRef = (key: ModelDefaultKey, ref: ModelRef) => {
    props.onChange((current) => ({
      ...current,
      defaults: {
        ...current.defaults,
        [key]: ref,
      },
    }));
  };
  const save = async () => {
    setPanelStatus("Saving...");
    try {
      await props.onSave();
      setPanelStatus("Saved");
    } catch (error) {
      setPanelStatus((error as Error).message || "Save failed");
    }
  };
  return (
    <SettingsGroup>
      {rows.map((row) => (
        <SettingsRow key={row.key} label={row.label} description={row.description}>
          <ModelRefControl config={props.config} value={props.config.defaults[row.key]} onChange={(ref) => updateRef(row.key, ref)} />
        </SettingsRow>
      ))}
      <SettingsRow label="Model config status" description={panelStatus || props.status}>
        <SettingsButton variant="primary" onClick={() => void save()}>Save defaults</SettingsButton>
      </SettingsRow>
    </SettingsGroup>
  );
}

function ModelRefControl({ config, value, onChange }: { config: ModelApiConfig; value: ModelRef; onChange: (value: ModelRef) => void }) {
  const provider = config.providers.find((item) => item.id === value.providerId) || config.providers[0];
  const listId = `models-${value.providerId}`;
  return (
    <div className="settings-model-ref-control">
      <select
        className="settings-select settings-provider-select"
        value={provider?.id || value.providerId}
        onChange={(event) => {
          const nextProvider = config.providers.find((item) => item.id === event.target.value) || config.providers[0];
          onChange({ providerId: nextProvider.id, model: nextProvider.models[0] || value.model });
        }}
      >
        {config.providers.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
      <input
        className="settings-text-input settings-model-input"
        list={listId}
        value={value.model}
        onChange={(event) => onChange({ ...value, model: event.target.value })}
      />
      <datalist id={listId}>
        {(provider?.models || []).map((model) => <option key={model} value={model} />)}
      </datalist>
    </div>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

function SettingsRow({ label, description, children, className = "" }: { label: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsTextInput(props: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <input
      className="settings-text-input"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function SettingsTextArea(props: { value: string; onChange: (value: string) => void }) {
  return (
    <textarea
      className="settings-text-area"
      value={props.value}
      rows={4}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function SettingsSelect(props: { value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <select className="settings-select" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function SettingsIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button className="settings-icon-button" type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function SettingsNumberInput(props: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const clamp = (value: number) => Math.min(Math.max(value, props.min), props.max);
  return (
    <input
      className="settings-number-input"
      type="number"
      min={props.min}
      max={props.max}
      step={1}
      value={Number.isFinite(props.value) ? props.value : props.min}
      onChange={(event) => props.onChange(clamp(Number(event.target.value) || props.min))}
    />
  );
}

function SettingsSwitch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <button
      className={`settings-switch ${checked ? "on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingsButton({
  children,
  disabled,
  onClick,
  variant = "secondary",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  variant?: SettingsButtonVariant;
}) {
  return (
    <button className={`settings-button ${variant}`} type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function StatusValue({ children }: { children: ReactNode }) {
  return <span className="settings-status-value">{children}</span>;
}

function oauthStatusLabel(mode: OAuthMode, copy: ReturnType<typeof getAppCopy>) {
  if (mode === "connected") return copy.settings.account.statuses.connected;
  if (mode === "polling") return copy.settings.account.statuses.polling;
  if (mode === "offline") return copy.settings.account.statuses.offline;
  if (mode === "mock") return copy.settings.account.statuses.mock;
  if (mode === "ready") return copy.settings.account.statuses.ready;
  return copy.settings.account.statuses.unknown;
}

function saveKindLabel(kind: SaveStatusKind, copy: ReturnType<typeof getAppCopy>) {
  if (kind === "saving") return copy.persistence.saving;
  if (kind === "saved") return copy.persistence.saved;
  if (kind === "quota") return copy.persistence.quota;
  if (kind === "error") return copy.persistence.failed;
  return copy.persistence.localDraft;
}

function persistentStatusLabel(status: PersistentStorageState, copy: ReturnType<typeof getAppCopy>) {
  if (status === "persisted") return copy.settings.storage.persisted;
  if (status === "best-effort") return copy.settings.storage.bestEffort;
  if (status === "unsupported") return copy.settings.storage.unsupported;
  return copy.settings.storage.unknown;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function splitModels(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function providerPreviewUrl(provider: ModelApiProvider) {
  if (provider.type === "codex-oauth") return "https://chatgpt.com/backend-api/codex/responses";
  const host = provider.apiHost.trim().replace(/\/+$/, "");
  if (!host) return "";
  if (provider.type === "openai-compatible" && isDeepSeekOfficialHost(host)) {
    return `${host}/chat/completions`;
  }
  const hasVersion = /\/v1$/i.test(host);
  const base = hasVersion ? host : `${host}/v1`;
  return `${base}/${provider.type === "openai-responses" ? "responses" : "chat/completions"}`;
}

function isDeepSeekOfficialHost(host: string) {
  try {
    return new URL(host).host.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}
