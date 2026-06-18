import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  FileText,
  Palette,
  Settings2,
  UserCircle,
  Wrench,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { UiPreferences } from "./settings";

type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";

export type SettingsSection =
  | "general"
  | "appearance"
  | "agent"
  | "pdf"
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
  { id: "general", label: "通用", icon: <Settings2 /> },
  { id: "appearance", label: "外观", icon: <Palette /> },
  { id: "agent", label: "助手", icon: <Bot /> },
  { id: "pdf", label: "PDF 阅读器", icon: <FileText /> },
  { id: "account", label: "账户 / 网关", icon: <UserCircle /> },
  { id: "advanced", label: "高级", icon: <Wrench /> },
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
                管理低频配置，保持阅读工作区干净。
              </Dialog.Description>
            </div>
            <div className="settings-panel">
              {section === "general" && (
                <SettingsGroup>
                  <SettingsRow label="保存界面偏好" description="在本机保存主题、密度和面板显示相关偏好。关闭后，本页修改只在当前会话生效。">
                    <SettingsSwitch
                      checked={props.preferences.autoSaveSession}
                      onCheckedChange={(checked) => props.onPreferenceChange("autoSaveSession", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="重置界面布局" description="恢复目录、讲解和助手面板。">
                    <SettingsButton onClick={props.onResetLayout}>重置布局</SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "appearance" && (
                <SettingsGroup>
                  <SettingsRow label="主题" description="切换 Claude-like 浅色、深色，或跟随系统外观。">
                    <SettingsSelect
                      value={props.preferences.theme}
                      onChange={(value) => props.onPreferenceChange("theme", value as UiPreferences["theme"])}
                      options={[
                        ["system", "跟随系统"],
                        ["light", "浅色"],
                        ["dark", "深色"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="强调色" description="切换工作区的强调色 token。">
                    <SettingsSelect
                      value={props.preferences.accentColor}
                      onChange={(value) => props.onPreferenceChange("accentColor", value as UiPreferences["accentColor"])}
                      options={[
                        ["clay", "陶土色"],
                        ["graphite", "石墨灰"],
                        ["sage", "鼠尾草绿"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="PDF 背景" description="调整文档背后的低噪声底色。">
                    <SettingsSelect
                      value={props.preferences.pdfBackground}
                      onChange={(value) => props.onPreferenceChange("pdfBackground", value as UiPreferences["pdfBackground"])}
                      options={[
                        ["paper", "纸张"],
                        ["plain", "纯净"],
                        ["soft", "柔和"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="字体大小" description="应用于讲解、助手输出和阅读文本。">
                    <SettingsSelect
                      value={props.preferences.fontScale}
                      onChange={(value) => props.onPreferenceChange("fontScale", value as UiPreferences["fontScale"])}
                      options={[
                        ["compact", "紧凑"],
                        ["default", "默认"],
                        ["large", "偏大"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="紧凑模式" description="减少 toolbar 和 pane 的间距。">
                    <SettingsSwitch
                      checked={props.preferences.compactMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("compactMode", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "agent" && (
                <SettingsGroup>
                  <SettingsRow label="显示来源 pill" description="在对话上方显示紧凑来源上下文。">
                    <SettingsSwitch
                      checked={props.preferences.showSourcePills}
                      onCheckedChange={(checked) => props.onPreferenceChange("showSourcePills", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="页面感知建议" description="根据当前页标题和概念生成空状态提示。">
                    <SettingsSwitch
                      checked={props.preferences.pageAwareSuggestions}
                      onCheckedChange={(checked) => props.onPreferenceChange("pageAwareSuggestions", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "pdf" && (
                <SettingsGroup>
                  <SettingsRow label="滚动条样式" description="应用于工作区滚动容器。">
                    <SettingsSelect
                      value={props.preferences.scrollbarStyle}
                      onChange={(value) => props.onPreferenceChange("scrollbarStyle", value as UiPreferences["scrollbarStyle"])}
                      options={[
                        ["thin", "细"],
                        ["subtle", "更弱"],
                        ["native", "系统默认"],
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label="显示页面摘要提示" description="在文档下方显示低噪声上下文提示。">
                    <SettingsSwitch
                      checked={props.preferences.showPageSummaryHint}
                      onCheckedChange={(checked) => props.onPreferenceChange("showPageSummaryHint", checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "account" && (
                <SettingsGroup>
                  <SettingsRow label="OAuth 状态" description="OpenAI Gateway 连接状态。">
                    <StatusValue>{oauthStatusLabel(props.oauthMode)}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="已连接邮箱" description="只在这里显示，不出现在主界面状态栏。">
                    <StatusValue>{props.oauthAccount || "未连接"}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="Provider 状态" description={props.documentTitle}>
                    <StatusValue>{props.providerStatus}</StatusValue>
                  </SettingsRow>
                  <SettingsRow label="重新连接 / 退出" description="复用现有 OAuth start/logout 流程。">
                    <SettingsButton onClick={props.onConnectOAuth}>
                      {props.oauthMode === "connected" ? "退出登录" : "连接 OpenAI"}
                    </SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              )}

              {section === "advanced" && (
                <SettingsGroup>
                  <SettingsRow label="Debug 模式" description="在低噪声 footer 中显示任务状态和诊断信息。">
                    <SettingsSwitch
                      checked={props.preferences.debugMode}
                      onCheckedChange={(checked) => props.onPreferenceChange("debugMode", checked)}
                    />
                  </SettingsRow>
                  <SettingsRow label="清除本地 UI 偏好" description="只重置本地视觉偏好。">
                    <SettingsButton onClick={props.onResetPreferences}>重置偏好</SettingsButton>
                  </SettingsRow>
                  <SettingsRow label="开发者诊断" description={props.preferences.debugMode ? props.jobStatus : "开启 Debug 模式后显示运行状态。"}>
                    <StatusValue>{props.preferences.debugMode ? "可见" : "隐藏"}</StatusValue>
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
  if (mode === "connected") return "已连接";
  if (mode === "polling") return "等待设备验证码";
  if (mode === "offline") return "后端未启动";
  if (mode === "mock") return "本地预览";
  if (mode === "ready") return "可连接";
  return "检查中";
}
