/** Runtime configuration, all from Worker vars (wrangler.toml [vars] or dashboard). */
export interface Env {
  PAY_TO?: string;
  X402_NETWORK?: string;
  FACILITATOR_URL?: string;
  PRICE_URL_CHECK?: string;
  PRICE_CITATION_CHECK?: string;
  PUBLIC_BASE_URL?: string;
  X402_DISABLED?: string;
  DEMO_ENABLED?: string;
  CONTACT_EMAIL?: string;
  BOT_CONTACT?: string;
  FETCH_USER_AGENT?: string;
  ALLOW_PRIVATE_TARGETS?: string;
}

export interface Settings {
  payTo: string;
  network: `${string}:${string}`;
  facilitatorUrl: string;
  priceUrlCheck: string;
  priceCitationCheck: string;
  publicBaseUrl: string | null;
  paymentsDisabled: boolean;
  allowPrivateTargets: boolean;
  demoEnabled: boolean;
  contactEmail: string | null;
  userAgent: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

export function loadSettings(env: Env = {}): Settings {
  // Public receive address only. No private keys are ever needed by a seller.
  const payTo = env.PAY_TO || "0x33190c9D2662F94A19CE88EA666f0ff8CeDe3700";
  if (!ADDR_RE.test(payTo)) throw new Error("PAY_TO must be a 0x-prefixed 20-byte EVM address");
  const publicBaseUrl = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") || null;
  const contactEmail = env.CONTACT_EMAIL || null;
  const contactParts = [publicBaseUrl || "https://github.com/something-agent/stillcurrent"];
  if (contactEmail) contactParts.push(contactEmail);
  const botContact = env.BOT_CONTACT || contactParts.join("; ");
  return {
    payTo,
    network: (env.X402_NETWORK || "eip155:8453") as `${string}:${string}`,
    facilitatorUrl: env.FACILITATOR_URL || "https://facilitator.payai.network",
    priceUrlCheck: env.PRICE_URL_CHECK || "$0.01",
    priceCitationCheck: env.PRICE_CITATION_CHECK || "$0.02",
    publicBaseUrl,
    paymentsDisabled: bool(env.X402_DISABLED, false),
    allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
    demoEnabled: bool(env.DEMO_ENABLED, true),
    contactEmail,
    userAgent:
      env.FETCH_USER_AGENT ||
      `Mozilla/5.0 (compatible; StillCurrentBot/0.1; link and citation checker; +${botContact})`,
  };
}
