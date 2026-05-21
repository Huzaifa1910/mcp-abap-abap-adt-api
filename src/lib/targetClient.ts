import { ADTClient, session_types } from "abap-adt-api";

let cached: ADTClient | undefined;

export interface TargetClientConfig {
  url?: string;
  user?: string;
  password?: string;
  client?: string;
  language?: string;
}

export function getTargetClientConfig(): TargetClientConfig {
  return {
    url: process.env.TARGET_SAP_URL,
    user: process.env.TARGET_SAP_USER,
    password: process.env.TARGET_SAP_PASSWORD,
    client: process.env.TARGET_SAP_CLIENT,
    language: process.env.TARGET_SAP_LANGUAGE
  };
}

export function targetClientStatus(): { configured: boolean; missing: string[]; cfg: TargetClientConfig } {
  const cfg = getTargetClientConfig();
  const required: Array<[string, string | undefined]> = [
    ['TARGET_SAP_URL', cfg.url],
    ['TARGET_SAP_USER', cfg.user],
    ['TARGET_SAP_PASSWORD', cfg.password]
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  return { configured: missing.length === 0, missing, cfg };
}

export function getTargetClient(): ADTClient {
  if (cached) return cached;
  const { configured, missing, cfg } = targetClientStatus();
  if (!configured) {
    throw new Error(
      `Target SAP not configured. Missing environment variables: ${missing.join(', ')}. ` +
      `Add them to your .env (TARGET_SAP_URL, TARGET_SAP_USER, TARGET_SAP_PASSWORD, optional TARGET_SAP_CLIENT/TARGET_SAP_LANGUAGE).`
    );
  }
  cached = new ADTClient(cfg.url!, cfg.user!, cfg.password!, cfg.client, cfg.language);
  cached.stateful = session_types.stateful;
  return cached;
}

export function resetTargetClient(): void {
  cached = undefined;
}
