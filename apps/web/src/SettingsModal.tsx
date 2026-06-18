import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  FileText,
  Keyboard,
  Palette,
  Settings2,
  UserCircle,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import type { UiPreferences } from "./settings";

type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";

export type SettingsSection =
  | "general"
  | "appearance"
  | "agent"
  | "pdf"
  | "generation"
  | "shortcuts"
  | "account"
  | "advanced";

type SettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  preferences: UiPreferences;
  onPreferenceChange: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
  onResetLayout: () => void;
  onResetPreferences: () => void;
  onConnectOAuth: () => void;
  oauthMode: OAuthMode;
  oauthAccount: string | null;
  providerStatus: string;
  jobStatus: string;
  documentTitle: string;
};

const sections: Array<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: "general", label: "General", icon: <Settings2 /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "agent", label: "Agent", icon: <Bot /> },
  { id: "pdf", label: "PDF Reader", icon: <FileText /> },
  { id: "generation", label: "Generation", icon: <Zap /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard /> },
  { id: "account", label: "Account / Gateway", icon: <UserCircle /> },
  { id: "advanced", label: "Advanced", icon: <Wrench /> },
];

export function SettingsModal(props: SettingsModalProps) {
  const section = props.activeSection;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="settings-overlay" />
        <Dialog.Content className="settings-dialog" aria-describedby="settings-description">
          <div className="settings-sidebar">
            <Dialog.Close className="settings-close" aria-label="关闭设置">
              <X />
            </Dialog.Close>
            <nav className="settings-nav" aria-label="Settings sections">
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
                Configure workspace preferences without cluttering the reader.
              </Dialog.Description>
            </div>
            <div className="settings-panel">
              {section === "general" && (
                <SettingsGroup>
                  <SettingsRow label="Language" description="Controls interface copy where localization is available.">
                    <SettingsSelect
                      value={props.preferences.language}
                      onChange={(value) => props.onPreferenceChange("language", value as UiPreferences["language"])}
                      options={[
                        ["auto", "Auto-detect"],
                        ["zh-CN", "中文"],
                        ["en", "English"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Default workspace mode" description="Saved as a preference for future workspace restore.">
                    <SettingsSelect
                      value={props.preferences.workspaceMode}
                      onChange={(value) => props.onPreferenceChange("workspaceMode", value as UiPreferences["workspaceMode"])}
                      options={[
                        ["full", "Full workspace"],
                        ["pdf-agent", "PDF + Agent"],
                        ["pdf-only", "PDF only"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Auto-save session" description="Keep local UI preferences and workspace state on this device.">
                    <SettingsSwitch
                      checked={props.preferences.autoSaveSession}
                      onCheckedChange={(checked) => props.onPreferenceChange("autoSaveSession", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Reset UI layout" description="Restore rail, notes, and agent panes.">
                    <SettingsButton onClick={props.onResetLayout}>Reset layout</SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "appearance" && (
                <SettingsGroup>
                  <SettingsRow label="Theme" description="Stored now; full dark mode is intentionally not enabled yet.">
                    <SettingsSelect
                      value={props.preferences.theme}
                      onChange={(value) => props.onPreferenceChange("theme", value as UiPreferences["theme"])}
                      options={[
                        ["system", "System"],
                        ["light", "Light"],
                        ["dark", "Dark"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Accent color" description="Changes the workspace accent token.">
                    <SettingsSelect
                      value={props.preferences.accentColor}
                      onChange={(value) => props.onPreferenceChange("accentColor", value as UiPreferences["accentColor"])}
                      options={[
                        ["clay", "Claude clay"],
                        ["graphite", "Graphite"],
                        ["sage", "Sage"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="PDF background style" description="Changes the quiet surface behind the document.">
                    <SettingsSelect
                      value={props.preferences.pdfBackground}
                      onChange={(value) => props.onPreferenceChange("pdfBackground", value as UiPreferences["pdfBackground"])}
                      options={[
                        ["paper", "Paper"],
                        ["plain", "Plain"],
                        ["soft", "Soft wash"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Font scale" description="Applies to notes, assistant output, and reader copy.">
                    <SettingsSelect
                      value={props.preferences.fontScale}
                      onChange={(value) => props.onPreferenceChange("fontScale", value as UiPreferences["fontScale"])}
                      options={[
                        ["compact", "Compact"],
                        ["default", "Default"],
                        ["large", "Large"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Compact mode" description="Reduces toolbar and pane spacing.">
                    <SettingsSwitch
                      checked={props.preferences.compactMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("compactMode", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "agent" && (
                <SettingsGroup>
                  <SettingsRow label="Default model" description="Used by the app request payload when model routing is connected.">
                    <SettingsSelect
                      value={props.preferences.defaultModel}
                      onChange={(value) => props.onPreferenceChange("defaultModel", value as UiPreferences["defaultModel"])}
                      options={[
                        ["gpt-5.5", "GPT-5.5"],
                        ["gpt-5.1", "GPT-5.1"],
                        ["local-preview", "Local preview"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Response style" description="Preference placeholder for future generation prompts.">
                    <SettingsSelect
                      value={props.preferences.responseStyle}
                      onChange={(value) => props.onPreferenceChange("responseStyle", value as UiPreferences["responseStyle"])}
                      options={[
                        ["concise", "Concise"],
                        ["teaching", "Teaching"],
                        ["socratic", "Socratic"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Auto-use selected PDF context" description="Controls future composer context behavior.">
                    <SettingsSwitch
                      checked={props.preferences.autoUseSelectedContext}
                      onCheckedChange={(checked) => props.onPreferenceChange("autoUseSelectedContext", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Show source pills" description="Show compact source context above the thread.">
                    <SettingsSwitch
                      checked={props.preferences.showSourcePills}
                      onCheckedChange={(checked) => props.onPreferenceChange("showSourcePills", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Page-aware suggestions" description="Use the current page title and concepts in empty-state prompts.">
                    <SettingsSwitch
                      checked={props.preferences.pageAwareSuggestions}
                      onCheckedChange={(checked) => props.onPreferenceChange("pageAwareSuggestions", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "pdf" && (
                <SettingsGroup>
                  <SettingsRow label="Default zoom" description="Stored for future PDF viewer controls.">
                    <SettingsSelect
                      value={props.preferences.defaultZoom}
                      onChange={(value) => props.onPreferenceChange("defaultZoom", value as UiPreferences["defaultZoom"])}
                      options={[
                        ["auto", "Auto"],
                        ["100", "100%"],
                        ["125", "125%"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Page fit mode" description="Stored for future native PDF preview controls.">
                    <SettingsSelect
                      value={props.preferences.pageFitMode}
                      onChange={(value) => props.onPreferenceChange("pageFitMode", value as UiPreferences["pageFitMode"])}
                      options={[
                        ["width", "Fit width"],
                        ["page", "Fit page"],
                        ["height", "Fit height"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Scrollbar style" description="Applies to workspace scroll containers.">
                    <SettingsSelect
                      value={props.preferences.scrollbarStyle}
                      onChange={(value) => props.onPreferenceChange("scrollbarStyle", value as UiPreferences["scrollbarStyle"])}
                      options={[
                        ["thin", "Thin"],
                        ["subtle", "Subtle"],
                        ["native", "Native"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Show page summary hint" description="Display the low-noise context hint below the document.">
                    <SettingsSwitch
                      checked={props.preferences.showPageSummaryHint}
                      onCheckedChange={(checked) => props.onPreferenceChange("showPageSummaryHint", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Enable text selection toolbar" description="Preference placeholder for the next selection toolbar pass.">
                    <SettingsSwitch
                      checked={props.preferences.enableSelectionToolbar}
                      onCheckedChange={(checked) => props.onPreferenceChange("enableSelectionToolbar", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "generation" && (
                <SettingsGroup>
                  <SettingsRow label="Output format" description="Saved for future generation jobs. Current generate button still calls the existing harness.">
                    <SettingsSelect
                      value={props.preferences.outputFormat}
                      onChange={(value) => props.onPreferenceChange("outputFormat", value as UiPreferences["outputFormat"])}
                      options={[
                        ["markdown", "Markdown"],
                        ["json", "JSON"],
                        ["markdown-json", "Markdown + JSON"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Notes style" description="Saved preference for future prompt routing.">
                    <SettingsSelect
                      value={props.preferences.notesStyle}
                      onChange={(value) => props.onPreferenceChange("notesStyle", value as UiPreferences["notesStyle"])}
                      options={[
                        ["teaching", "Teaching"],
                        ["concise", "Concise"],
                        ["exam", "Exam prep"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="Quiz generation options" description="Future setting for quiz-style outputs.">
                    <SettingsSwitch
                      checked={props.preferences.quizOptions}
                      onCheckedChange={(checked) => props.onPreferenceChange("quizOptions", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Include citations" description="Saved for future generated notes and exports.">
                    <SettingsSwitch
                      checked={props.preferences.includeCitations}
                      onCheckedChange={(checked) => props.onPreferenceChange("includeCitations", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "shortcuts" && (
                <SettingsGroup>
                  <ShortcutRow label="Open settings" shortcut="," />
                  <ShortcutRow label="Send selected text to Agent" shortcut="S" />
                  <ShortcutRow label="Toggle Agent pane" shortcut="A" />
                  <ShortcutRow label="Generate" shortcut="G" />
                </SettingsGroup>
              )}

              {section === "account" && (
                <SettingsGroup>
                  <SettingsRow label="OAuth status" description="OpenAI Gateway connection state.">
                    <StatusValue>{oauthStatusLabel(props.oauthMode)}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="Connected email" description="Only shown here, not in the main status bar.">
                    <StatusValue>{props.oauthAccount || "Not connected"}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="Provider status" description={props.documentTitle}>
                    <StatusValue>{props.providerStatus}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="Reconnect / sign out" description="Uses the existing OAuth start/logout flow.">
                    <SettingsButton onClick={props.onConnectOAuth}>
                      {props.oauthMode === "connected" ? "Sign out" : "Connect OpenAI"}
                    </SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "advanced" && (
                <SettingsGroup>
                  <SettingsRow label="Debug mode" description="Show job status and diagnostics in the low-noise footer.">
                    <SettingsSwitch
                      checked={props.preferences.debugMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("debugMode", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="Clear local UI preferences" description="Resets only local visual preferences.">
                    <SettingsButton onClick={props.onResetPreferences}>Reset preferences</SettingsButton>
                  </SettingsRow>
                  <SettingsRow label="Export session data" description="Placeholder for a future session export action.">
                    <SettingsButton disabled>Coming soon</SettingsButton>
                  </SettingsRow>
                  <SettingsRow label="Developer diagnostics" description={props.preferences.debugMode ? props.jobStatus : "Enable debug mode to show runtime status."}>
                    <StatusValue>{props.preferences.debugMode ? "Visible" : "Hidden"}</StatusValue>
                  </SettingsRow>
                </SettingsGroup>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function ShortcutRow({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-label">{label}</div>
      </div>
      <kbd className="settings-kbd">{shortcut}</kbd>
    </div>
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

function SettingsButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className="settings-button" type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function StatusValue({ children }: { children: ReactNode }) {
  return <span className="settings-status-value">{children}</span>;
}

function oauthStatusLabel(mode: OAuthMode) {
  if (mode === "connected") return "Connected";
  if (mode === "polling") return "Waiting for device code";
  if (mode === "offline") return "Backend offline";
  if (mode === "mock") return "Local preview";
  if (mode === "ready") return "Ready to connect";
  return "Checking";
}
