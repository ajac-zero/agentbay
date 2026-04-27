import { z } from "zod";

const nonEmptyString = z.string().trim().min(1, "must not be empty");
const portSchema = z.coerce
  .number()
  .int("must be an integer")
  .min(1, "must be between 1 and 65535")
  .max(65535, "must be between 1 and 65535");

const envSchema = z
  .object({
    PORT: portSchema.default(3000),
    NAMESPACE: nonEmptyString,
    SANDBOX_TEMPLATE_NAME: nonEmptyString,
    SANDBOX_ROUTER_URL: z.url(),
    SANDBOX_PORT: portSchema.default(8888),
    STATE_BACKEND_URL: z.url(),

    SLACK_SIGNING_SECRET: nonEmptyString.optional(),
    SLACK_BOT_TOKEN: nonEmptyString.optional(),
    SLACK_CLIENT_ID: nonEmptyString.optional(),
    SLACK_CLIENT_SECRET: nonEmptyString.optional(),

    DISCORD_PUBLIC_KEY: nonEmptyString.optional(),
    DISCORD_BOT_TOKEN: nonEmptyString.optional(),

    TELEGRAM_BOT_TOKEN: nonEmptyString.optional(),
    GITHUB_WEBHOOK_SECRET: nonEmptyString.optional(),
    LINEAR_WEBHOOK_SECRET: nonEmptyString.optional(),
    GOOGLE_CHAT_VERIFICATION_TOKEN: nonEmptyString.optional(),

    WHATSAPP_VERIFY_TOKEN: nonEmptyString.optional(),
    WHATSAPP_ACCESS_TOKEN: nonEmptyString.optional(),

    MICROSOFT_TEAMS_APP_ID: nonEmptyString.optional(),
    MICROSOFT_TEAMS_APP_PASSWORD: nonEmptyString.optional(),
  })
  .superRefine((env, ctx) => {
    requireTogether(ctx, env, "Slack", [
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
    ]);
    requireTogether(ctx, env, "Discord", ["DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN"]);
    requireTogether(ctx, env, "WhatsApp", ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN"]);
    requireTogether(ctx, env, "Microsoft Teams", [
      "MICROSOFT_TEAMS_APP_ID",
      "MICROSOFT_TEAMS_APP_PASSWORD",
    ]);
  });

type Env = z.infer<typeof envSchema>;

type EnvKey = keyof Env;

function requireTogether(
  ctx: z.core.$RefinementCtx<Env>,
  env: Env,
  platform: string,
  keys: readonly EnvKey[],
) {
  const providedKeys = keys.filter((key) => env[key] !== undefined);

  if (providedKeys.length === 0 || providedKeys.length === keys.length) {
    return;
  }

  for (const key of keys) {
    if (env[key] !== undefined) {
      continue;
    }

    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is required when ${platform} is configured`,
    });
  }
}

function formatConfigError(error: z.ZodError) {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `- ${path}: ${issue.message}`;
  });

  return ["Invalid environment configuration:", ...issues].join("\n");
}

export function loadConfig(source: Record<string, string | undefined> = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(formatConfigError(result.error));
  }

  const env = result.data;

  return {
    server: {
      port: env.PORT,
    },
    kubernetes: {
      namespace: env.NAMESPACE,
    },
    sandbox: {
      templateName: env.SANDBOX_TEMPLATE_NAME,
      routerUrl: new URL(env.SANDBOX_ROUTER_URL),
      port: env.SANDBOX_PORT,
    },
    stateBackend: {
      url: new URL(env.STATE_BACKEND_URL),
    },
    platforms: {
      slack:
        env.SLACK_SIGNING_SECRET === undefined
          ? null
          : {
              signingSecret: env.SLACK_SIGNING_SECRET,
              botToken: env.SLACK_BOT_TOKEN,
              clientId: env.SLACK_CLIENT_ID,
              clientSecret: env.SLACK_CLIENT_SECRET,
            },
      discord:
        env.DISCORD_PUBLIC_KEY === undefined
          ? null
          : {
              publicKey: env.DISCORD_PUBLIC_KEY,
              botToken: env.DISCORD_BOT_TOKEN,
            },
      telegram:
        env.TELEGRAM_BOT_TOKEN === undefined
          ? null
          : {
              botToken: env.TELEGRAM_BOT_TOKEN,
            },
      github:
        env.GITHUB_WEBHOOK_SECRET === undefined
          ? null
          : {
              webhookSecret: env.GITHUB_WEBHOOK_SECRET,
            },
      linear:
        env.LINEAR_WEBHOOK_SECRET === undefined
          ? null
          : {
              webhookSecret: env.LINEAR_WEBHOOK_SECRET,
            },
      googleChat:
        env.GOOGLE_CHAT_VERIFICATION_TOKEN === undefined
          ? null
          : {
              verificationToken: env.GOOGLE_CHAT_VERIFICATION_TOKEN,
            },
      whatsapp:
        env.WHATSAPP_VERIFY_TOKEN === undefined
          ? null
          : {
              verifyToken: env.WHATSAPP_VERIFY_TOKEN,
              accessToken: env.WHATSAPP_ACCESS_TOKEN,
            },
      microsoftTeams:
        env.MICROSOFT_TEAMS_APP_ID === undefined
          ? null
          : {
              appId: env.MICROSOFT_TEAMS_APP_ID,
              appPassword: env.MICROSOFT_TEAMS_APP_PASSWORD,
            },
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config = loadConfig();
