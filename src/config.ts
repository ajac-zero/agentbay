export type Config = {
  adminToken?: string;
  botUserName: string;
  claimPollIntervalMs: number;
  claimReadyTimeoutMs: number;
  claimShutdownHours: number;
  claimTtlSecondsAfterFinished: number;
  kubeNamespace: string;
  opencodeDirectory: string;
  opencodePort: number;
  port: number;
  redisUrl?: string;
  discord: AdapterToggle;
  gchat: AdapterToggle;
  github: AdapterToggle;
  linear: AdapterToggle;
  messenger: AdapterToggle;
  slack: AdapterToggle;
  teams: AdapterToggle;
  telegram: AdapterToggle;
  whatsapp: AdapterToggle;
};

type AdapterToggle = {
  enabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    adminToken: emptyToUndefined(env.AGENTBAY_ADMIN_TOKEN),
    botUserName: env.AGENTBAY_BOT_USER_NAME ?? "agentbay",
    claimPollIntervalMs: readNumber(env.AGENTBAY_CLAIM_POLL_INTERVAL_MS, 1_000),
    claimReadyTimeoutMs: readNumber(env.AGENTBAY_CLAIM_READY_TIMEOUT_MS, 180_000),
    claimShutdownHours: readNumber(env.AGENTBAY_CLAIM_SHUTDOWN_HOURS, 4),
    claimTtlSecondsAfterFinished: readNumber(env.AGENTBAY_CLAIM_TTL_SECONDS, 1_800),
    kubeNamespace: env.AGENTBAY_KUBE_NAMESPACE ?? env.POD_NAMESPACE ?? "agents",
    opencodeDirectory: env.AGENTBAY_OPENCODE_DIRECTORY ?? "/workspace",
    opencodePort: readNumber(env.AGENTBAY_OPENCODE_PORT, 4096),
    port: readNumber(env.PORT, 3000),
    redisUrl: emptyToUndefined(env.REDIS_URL),
    discord: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_DISCORD_ENABLED",
        hasDiscordConfig(env),
        "Discord",
        "DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, and DISCORD_APPLICATION_ID",
      ),
    },
    gchat: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_GOOGLE_CHAT_ENABLED",
        hasGoogleChatConfig(env),
        "Google Chat",
        "GOOGLE_CHAT_CREDENTIALS or GOOGLE_CHAT_USE_ADC=true, plus GOOGLE_CHAT_PROJECT_NUMBER, GOOGLE_CHAT_PUBSUB_AUDIENCE, or GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION=true",
      ),
    },
    github: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_GITHUB_ENABLED",
        hasGitHubConfig(env),
        "GitHub",
        "GITHUB_WEBHOOK_SECRET and either GITHUB_TOKEN or GITHUB_APP_ID/GITHUB_PRIVATE_KEY",
      ),
    },
    linear: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_LINEAR_ENABLED",
        hasLinearConfig(env),
        "Linear",
        "LINEAR_WEBHOOK_SECRET and one Linear auth method",
      ),
    },
    messenger: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_MESSENGER_ENABLED",
        hasMessengerConfig(env),
        "Messenger",
        "FACEBOOK_APP_SECRET, FACEBOOK_PAGE_ACCESS_TOKEN, and FACEBOOK_VERIFY_TOKEN",
      ),
    },
    slack: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_SLACK_ENABLED",
        hasSlackConfig(env),
        "Slack",
        "SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET",
      ),
    },
    teams: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_TEAMS_ENABLED",
        hasTeamsConfig(env),
        "Teams",
        "TEAMS_APP_ID and TEAMS_APP_PASSWORD",
      ),
    },
    telegram: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_TELEGRAM_ENABLED",
        hasTelegramConfig(env),
        "Telegram",
        "TELEGRAM_BOT_TOKEN",
        { allowExplicitWithoutConfig: true },
      ),
    },
    whatsapp: {
      enabled: readAdapterEnabled(
        env,
        "AGENTBAY_WHATSAPP_ENABLED",
        hasWhatsAppConfig(env),
        "WhatsApp",
        "WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_VERIFY_TOKEN",
      ),
    },
  };
}

function readAdapterEnabled(
  env: NodeJS.ProcessEnv,
  enabledEnvName: string,
  hasRequiredConfig: boolean,
  label: string,
  requirements: string,
  options: { allowExplicitWithoutConfig?: boolean } = {},
): boolean {
  const explicitlyConfigured = env[enabledEnvName] !== undefined && env[enabledEnvName] !== "";
  const enabled = explicitlyConfigured ? readBoolean(env[enabledEnvName], false) : hasRequiredConfig;

  if (enabled && !hasRequiredConfig && !(explicitlyConfigured && options.allowExplicitWithoutConfig)) {
    throw new Error(`${label} is enabled, but ${requirements} must be set`);
  }

  return enabled;
}

function hasDiscordConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "DISCORD_BOT_TOKEN") && hasEnv(env, "DISCORD_PUBLIC_KEY") && hasEnv(env, "DISCORD_APPLICATION_ID");
}

function hasSlackConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "SLACK_BOT_TOKEN") && hasEnv(env, "SLACK_SIGNING_SECRET");
}

function hasGitHubConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "GITHUB_WEBHOOK_SECRET") && (hasEnv(env, "GITHUB_TOKEN") || (hasEnv(env, "GITHUB_APP_ID") && hasEnv(env, "GITHUB_PRIVATE_KEY")));
}

function hasGoogleChatConfig(env: NodeJS.ProcessEnv): boolean {
  const hasAuth = hasEnv(env, "GOOGLE_CHAT_CREDENTIALS") || readBoolean(env.GOOGLE_CHAT_USE_ADC, false);
  const hasWebhookVerification =
    hasEnv(env, "GOOGLE_CHAT_PROJECT_NUMBER") ||
    hasEnv(env, "GOOGLE_CHAT_PUBSUB_AUDIENCE") ||
    readBoolean(env.GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION, false);

  return hasAuth && hasWebhookVerification;
}

function hasLinearConfig(env: NodeJS.ProcessEnv): boolean {
  const hasAuth =
    hasEnv(env, "LINEAR_API_KEY") ||
    hasEnv(env, "LINEAR_ACCESS_TOKEN") ||
    (hasEnv(env, "LINEAR_CLIENT_CREDENTIALS_CLIENT_ID") && hasEnv(env, "LINEAR_CLIENT_CREDENTIALS_CLIENT_SECRET")) ||
    (hasEnv(env, "LINEAR_CLIENT_ID") && hasEnv(env, "LINEAR_CLIENT_SECRET"));

  return hasEnv(env, "LINEAR_WEBHOOK_SECRET") && hasAuth;
}

function hasMessengerConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "FACEBOOK_APP_SECRET") && hasEnv(env, "FACEBOOK_PAGE_ACCESS_TOKEN") && hasEnv(env, "FACEBOOK_VERIFY_TOKEN");
}

function hasTeamsConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "TEAMS_APP_ID") && hasEnv(env, "TEAMS_APP_PASSWORD");
}

function hasTelegramConfig(env: NodeJS.ProcessEnv): boolean {
  return hasEnv(env, "TELEGRAM_BOT_TOKEN");
}

function hasWhatsAppConfig(env: NodeJS.ProcessEnv): boolean {
  return (
    hasEnv(env, "WHATSAPP_ACCESS_TOKEN") &&
    hasEnv(env, "WHATSAPP_APP_SECRET") &&
    hasEnv(env, "WHATSAPP_PHONE_NUMBER_ID") &&
    hasEnv(env, "WHATSAPP_VERIFY_TOKEN")
  );
}

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return emptyToUndefined(env[name]) !== undefined;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected numeric env value, got ${value}`);
  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
