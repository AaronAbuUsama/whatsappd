import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PRIVATE_MATERIAL = [
  /\b\d{5,}@(s\.whatsapp\.net|g\.us|lid|broadcast)\b/i,
  /\.whatsappd-media|WHATSAPPD_(?:PROFILE_DIR|ACCOUNT_ID)/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
  /(?:qr|pairing)[_-]?(?:code|secret|token|value)/i,
] as const;

export function assertNoPrivateMaterial(source: string, label: string): void {
  for (const pattern of PRIVATE_MATERIAL)
    if (pattern.test(source)) throw new Error(`${label} matched forbidden pattern ${pattern}`);
}

export function stateLabFixtureSources(webRoot: URL): {
  readonly files: readonly string[];
  readonly source: string;
} {
  const files = execFileSync(
    "git",
    ["ls-files", "*fixture*", "*state-lab*", "*.stories.*", "public/**"],
    { cwd: webRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((file) => file && !file.startsWith("tests/"));
  return {
    files,
    source: files.map((file) => readFileSync(new URL(file, webRoot), "utf8")).join("\n"),
  };
}
