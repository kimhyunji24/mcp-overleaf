import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface OverleafCredential {
  gitToken: string;
  updatedAt: string;
}

type EncryptedRecord = { iv: string; tag: string; ciphertext: string; updatedAt: string };

/**
 * Small file-backed vault for a single deployment. Deployments needing replicas
 * should replace this interface with a KMS-backed database implementation.
 */
export class CredentialStore {
  private readonly key: Buffer;

  constructor(private readonly dir: string, encryptionKey: string) {
    this.key = Buffer.from(encryptionKey, "base64");
    if (this.key.length !== 32) throw new Error("OVERLEAF_CREDENTIALS_KEY must be a base64-encoded 32-byte key.");
  }

  private file(subject: string): string {
    // Auth0 subjects can contain punctuation. Base64url keeps the filename portable.
    return path.join(this.dir, Buffer.from(subject).toString("base64url") + ".json");
  }

  async get(subject: string): Promise<OverleafCredential | undefined> {
    let record: EncryptedRecord;
    try {
      record = JSON.parse(await fs.readFile(this.file(subject), "utf8")) as EncryptedRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const gitToken = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return { gitToken, updatedAt: record.updatedAt };
  }

  async put(subject: string, gitToken: string): Promise<void> {
    if (!gitToken.trim()) throw new Error("An Overleaf Git token is required.");
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(gitToken.trim(), "utf8"), cipher.final()]);
    const record: EncryptedRecord = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    const target = this.file(subject);
    const temporary = target + "." + randomBytes(8).toString("hex") + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async delete(subject: string): Promise<void> {
    await fs.rm(this.file(subject), { force: true });
  }
}
