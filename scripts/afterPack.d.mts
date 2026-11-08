export interface SpeechRuntime {
  speech: string;
  sharedProviders: string;
  app: string;
}
export function speechRuntimes(modules: string): Promise<SpeechRuntime[]>;
export function useAppRuntimeForSpeech(modules: string): Promise<void>;
export function macHelperPath(appOutDir: string, productFilename: string, name?: string): string;
export default function afterPack(
  context: {
    electronPlatformName: string;
    appOutDir: string;
    packager?: { appInfo: { productFilename: string } };
  },
  build?: (output: string, platform: NodeJS.Platform) => Promise<boolean>,
  buildWatcher?: (output: string, platform: NodeJS.Platform) => Promise<boolean>,
): Promise<void>;
