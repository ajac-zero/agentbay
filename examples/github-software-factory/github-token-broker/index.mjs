import { parseStartupConfig, readGitHubAppCredentials } from "./config.mjs";
import { startBroker } from "./server.mjs";
import { InstallationTokenProvider } from "./token.mjs";

const config = parseStartupConfig();
const provider = new InstallationTokenProvider(config, () => readGitHubAppCredentials(config.credentialPaths));
await provider.getToken();
await startBroker(config, provider);
