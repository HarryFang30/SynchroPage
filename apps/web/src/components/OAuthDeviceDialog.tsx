import { Check, Clock, Copy, ExternalLink, X } from "lucide-react";
import type { AppCopy } from "../i18n";
import type { OAuthDevicePrompt } from "../hooks/useOAuthFlow";

export function OAuthDeviceDialog(props: {
  copy: AppCopy;
  device: OAuthDevicePrompt;
  secondsLeft: number;
  copied: boolean;
  onCopy: () => void;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const groups = splitOAuthUserCode(props.device.user_code);

  return (
    <section className="oauth-device-panel" role="dialog" aria-labelledby="oauth-device-title" aria-live="polite">
      <div className="oauth-device-header">
        <div>
          <p>{props.copy.oauth.kicker}</p>
          <h2 id="oauth-device-title">{props.copy.oauth.title}</h2>
        </div>
        <button
          className="oauth-device-close"
          type="button"
          aria-label={props.copy.oauth.cancel}
          title={props.copy.oauth.cancel}
          onClick={props.onCancel}
        >
          <X />
        </button>
      </div>

      <div className="oauth-code-display" aria-label={props.copy.oauth.codeAria(props.device.user_code)}>
        {groups.map((group, groupIndex) => (
          <div className="oauth-code-group" key={`${group}-${groupIndex}`}>
            {groupIndex > 0 && <span className="oauth-code-separator">-</span>}
            {[...group].map((char, index) => (
              <span className="oauth-code-cell" key={`${char}-${index}`}>{char}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="oauth-device-actions">
        <button className="oauth-secondary-button" type="button" onClick={props.onCopy}>
          {props.copied ? <Check /> : <Copy />}
          {props.copied ? props.copy.oauth.copied : props.copy.oauth.copyCode}
        </button>
        <button className="oauth-primary-button" type="button" onClick={props.onOpen}>
          <ExternalLink />
          {props.copy.oauth.openAuthPage}
        </button>
      </div>

      <div className="oauth-device-meta">
        <span><Clock /> {props.copy.oauth.expiresIn(formatSeconds(props.secondsLeft))}</span>
        <span>{props.device.verification_uri}</span>
      </div>
    </section>
  );
}

function splitOAuthUserCode(value: string) {
  const compact = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (compact.length === 9) return [compact.slice(0, 4), compact.slice(4)];
  const groups = value.split("-").map((group) => group.trim()).filter(Boolean);
  return groups.length ? groups : [value];
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
