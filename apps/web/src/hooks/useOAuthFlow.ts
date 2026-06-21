import { useCallback, useEffect, useRef, useState } from "react";
import type { AppCopy } from "../i18n";
import { requestJson } from "../lib/http/requestJson";

export type OAuthMode = "unknown" | "ready" | "connected" | "polling" | "offline" | "mock";

export type OAuthDevicePrompt = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  expires_at_ms: number;
};

export function useOAuthFlow(args: {
  copy: AppCopy;
  setJobStatus: (message: string | ((current: string) => string)) => void;
}) {
  const { copy, setJobStatus } = args;
  const [oauthMode, setOauthMode] = useState<OAuthMode>("unknown");
  const [oauthAccount, setOauthAccount] = useState<string | null>(null);
  const [oauthDevice, setOauthDevice] = useState<OAuthDevicePrompt | null>(null);
  const [oauthCodeCopied, setOauthCodeCopied] = useState(false);
  const [oauthSecondsLeft, setOauthSecondsLeft] = useState(0);
  const oauthPollTimerRef = useRef<number | null>(null);
  const oauthCountdownTimerRef = useRef<number | null>(null);
  const codeCopiedResetTimerRef = useRef<number | null>(null);

  const clearCopiedResetTimer = useCallback(() => {
    if (codeCopiedResetTimerRef.current !== null) {
      window.clearTimeout(codeCopiedResetTimerRef.current);
      codeCopiedResetTimerRef.current = null;
    }
  }, []);

  const resetCopiedSoon = useCallback(() => {
    clearCopiedResetTimer();
    codeCopiedResetTimerRef.current = window.setTimeout(() => {
      setOauthCodeCopied(false);
      codeCopiedResetTimerRef.current = null;
    }, 1800);
  }, [clearCopiedResetTimer]);

  const stopOAuthTimers = useCallback(() => {
    if (oauthPollTimerRef.current !== null) {
      window.clearInterval(oauthPollTimerRef.current);
      oauthPollTimerRef.current = null;
    }
    if (oauthCountdownTimerRef.current !== null) {
      window.clearInterval(oauthCountdownTimerRef.current);
      oauthCountdownTimerRef.current = null;
    }
    clearCopiedResetTimer();
  }, [clearCopiedResetTimer]);

  const refreshOAuthStatus = useCallback(async () => {
    try {
      const status = await requestJson<{
        authenticated: boolean;
        accounts?: Array<{ is_default?: boolean; login?: string; id?: string }>;
      }>("/auth/openai/status");
      const account = status.accounts?.find((item) => item.is_default) || status.accounts?.[0];
      setOauthMode(status.authenticated ? "connected" : "ready");
      setOauthAccount(account?.login || account?.id || null);
    } catch {
      setOauthMode("offline");
      setOauthAccount(null);
    }
  }, []);

  const copyOAuthUserCode = useCallback(async () => {
    if (!oauthDevice) return;
    await navigator.clipboard?.writeText(oauthDevice.user_code).catch(() => undefined);
    setOauthCodeCopied(true);
    setJobStatus(copy.status.codeCopied(oauthDevice.user_code));
    resetCopiedSoon();
  }, [copy.status, oauthDevice, resetCopiedSoon, setJobStatus]);

  const openOAuthVerification = useCallback(() => {
    if (!oauthDevice) return;
    window.open(oauthDevice.verification_uri, "_blank", "noopener,noreferrer");
    setJobStatus(copy.status.enterCode(oauthDevice.user_code));
  }, [copy.status, oauthDevice, setJobStatus]);

  const cancelOAuthLogin = useCallback(() => {
    stopOAuthTimers();
    setOauthDevice(null);
    setOauthSecondsLeft(0);
    setOauthCodeCopied(false);
    setOauthMode((mode) => (mode === "polling" ? "ready" : mode));
    setJobStatus(copy.status.oauthCanceled);
  }, [copy.status.oauthCanceled, setJobStatus, stopOAuthTimers]);

  const connectOAuth = useCallback(async () => {
    try {
      if (oauthMode === "polling" && oauthDevice) {
        await copyOAuthUserCode();
        return;
      }
      const status = await requestJson<{ authenticated: boolean }>("/auth/openai/status");
      if (status.authenticated) {
        stopOAuthTimers();
        await requestJson("/auth/openai/logout", { method: "POST" });
        setOauthMode("ready");
        setOauthAccount(null);
        setOauthDevice(null);
        setOauthSecondsLeft(0);
        setJobStatus(copy.status.oauthDisconnected);
        return;
      }
      stopOAuthTimers();
      const device = await requestJson<{
        user_code: string;
        device_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      }>("/auth/openai/start", { method: "POST" });
      const expiresAt = Date.now() + device.expires_in * 1000;
      const nextDevice = { ...device, expires_at_ms: expiresAt };
      setOauthDevice(nextDevice);
      setOauthSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
      setOauthCodeCopied(false);
      await navigator.clipboard?.writeText(device.user_code).catch(() => undefined);
      setOauthCodeCopied(true);
      resetCopiedSoon();
      setOauthMode("polling");
      setJobStatus(copy.status.codeShown(device.user_code));

      oauthCountdownTimerRef.current = window.setInterval(() => {
        const secondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        setOauthSecondsLeft(secondsLeft);
      }, 1000);

      const pollOnce = async () => {
        if (Date.now() > expiresAt) {
          stopOAuthTimers();
          setOauthMode("ready");
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setJobStatus(copy.status.codeExpired);
          return;
        }
        try {
          const account = await requestJson<{ login?: string; id?: string } | null>(
            "/auth/openai/poll",
            {
              method: "POST",
              body: JSON.stringify({ device_code: device.device_code }),
            },
          );
          if (!account) return;
          stopOAuthTimers();
          setOauthMode("connected");
          setOauthAccount(account.login || account.id || null);
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setOauthCodeCopied(false);
          setJobStatus(copy.status.oauthConnected);
        } catch (error) {
          stopOAuthTimers();
          setOauthMode("ready");
          setOauthDevice(null);
          setOauthSecondsLeft(0);
          setOauthCodeCopied(false);
          setJobStatus((error as Error).message);
        }
      };

      void pollOnce();
      oauthPollTimerRef.current = window.setInterval(pollOnce, Math.max(device.interval || 8, 8) * 1000);
    } catch {
      stopOAuthTimers();
      setOauthDevice(null);
      setOauthSecondsLeft(0);
      setOauthMode((mode) => (mode === "mock" ? "offline" : "mock"));
      setOauthAccount((account) => (account ? null : "static preview"));
      setJobStatus(copy.status.oauthBackendMock);
    }
  }, [copy.status, copyOAuthUserCode, oauthDevice, oauthMode, resetCopiedSoon, setJobStatus, stopOAuthTimers]);

  useEffect(() => {
    void refreshOAuthStatus();
  }, [refreshOAuthStatus]);

  useEffect(() => () => stopOAuthTimers(), [stopOAuthTimers]);

  return {
    oauthMode,
    oauthAccount,
    oauthDevice,
    oauthCodeCopied,
    oauthSecondsLeft,
    refreshOAuthStatus,
    copyOAuthUserCode,
    openOAuthVerification,
    cancelOAuthLogin,
    connectOAuth,
  };
}
