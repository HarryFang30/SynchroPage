/// <reference types="vite/client" />

type SynchroPageDesktopStorageConfig = {
  available: boolean;
  currentDataDir: string | null;
  configuredDataDir: string | null;
  pendingDataDir: string | null;
  backendDataDir: string | null;
  oauthStoragePath: string | null;
  configPath: string | null;
  dataDirManagedByEnv: boolean;
  restartRequired: boolean;
  canceled?: boolean;
};

interface Window {
  synchropageDesktop?: {
    getStorageConfig: () => Promise<SynchroPageDesktopStorageConfig>;
    chooseDataDirectory: () => Promise<SynchroPageDesktopStorageConfig>;
    resetDataDirectory: () => Promise<SynchroPageDesktopStorageConfig>;
    restart: () => Promise<{ ok: true }>;
  };
}
