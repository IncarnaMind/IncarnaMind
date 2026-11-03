export interface SpeechRuntime {
  speech: string;
  sharedProviders: string;
  app: string;
}
export function speechRuntimes(modules: string): Promise<SpeechRuntime[]>;
export function useAppRuntimeForSpeech(modules: string): Promise<void>;
export default function afterPack(context: {
  electronPlatformName: string;
  appOutDir: string;
}): Promise<void>;
