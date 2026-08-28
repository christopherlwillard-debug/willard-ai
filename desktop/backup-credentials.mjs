#!/usr/bin/env node

/**
 * Portable recovery export for the database-backup command.
 *
 * The Windows launcher keeps the unattended backup secret in DPAPI-protected
 * local storage. This file is intentionally separate: it is an encrypted,
 * user-selected recovery export that can be copied to a replacement computer.
 * It never belongs in the NAS backup directory.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const RECOVERY_EXPORT_FORMAT = "willard-backup-recovery-export";
export const RECOVERY_EXPORT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KDF = Object.freeze({ name: "scrypt", N: 16_384, r: 8, p: 1, keyLength: 32 });

function fail(message) {
  throw new Error(message);
}

function requireSecret(value, label) {
  if (typeof value !== "string" || value.length < 12) {
    fail(`${label} must contain at least 12 characters.`);
  }
  return value;
}

function decode(value, bytes, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(`Recovery export has an invalid ${label}.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (bytes !== null && decoded.length !== bytes) fail(`Recovery export has an invalid ${label} length.`);
  return decoded;
}

function authenticatedPart(exported) {
  return {
    format: exported.format,
    version: exported.version,
    createdAt: exported.createdAt,
    algorithm: exported.algorithm,
    kdf: exported.kdf,
    salt: exported.salt,
    iv: exported.iv,
  };
}

function aad(exported) {
  return Buffer.from(JSON.stringify(authenticatedPart(exported)), "utf8");
}

function key(passphrase, salt) {
  return scryptSync(requireSecret(passphrase, "The recovery export passphrase"), salt, KDF.keyLength, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

export function validateRecoveryExport(exported) {
  if (
    !exported ||
    exported.format !== RECOVERY_EXPORT_FORMAT ||
    exported.version !== RECOVERY_EXPORT_VERSION ||
    exported.algorithm !== ALGORITHM ||
    exported.kdf?.name !== KDF.name ||
    exported.kdf?.N !== KDF.N ||
    exported.kdf?.r !== KDF.r ||
    exported.kdf?.p !== KDF.p ||
    exported.kdf?.keyLength !== KDF.keyLength ||
    typeof exported.createdAt !== "string" ||
    Number.isNaN(Date.parse(exported.createdAt))
  ) {
    fail("The recovery export is not a supported Willard backup export.");
  }
  decode(exported.salt, 16, "salt");
  decode(exported.iv, 12, "IV");
  decode(exported.authTag, 16, "authentication tag");
  decode(exported.ciphertext, null, "encrypted secret");
  if (!exported.ciphertext) fail("Recovery export has no encrypted secret.");
  return exported;
}

export function createRecoveryExport(backupSecret, exportPassphrase) {
  requireSecret(backupSecret, "The backup secret");
  requireSecret(exportPassphrase, "The recovery export passphrase");
  const exported = {
    format: RECOVERY_EXPORT_FORMAT,
    version: RECOVERY_EXPORT_VERSION,
    createdAt: new Date().toISOString(),
    algorithm: ALGORITHM,
    kdf: KDF,
    salt: randomBytes(16).toString("base64"),
    iv: randomBytes(12).toString("base64"),
    authTag: "",
    ciphertext: "",
  };
  const cipher = createCipheriv(ALGORITHM, key(exportPassphrase, Buffer.from(exported.salt, "base64")), Buffer.from(exported.iv, "base64"));
  cipher.setAAD(aad(exported));
  exported.ciphertext = Buffer.concat([
    cipher.update(Buffer.from(backupSecret, "utf8")),
    cipher.final(),
  ]).toString("base64");
  exported.authTag = cipher.getAuthTag().toString("base64");
  return `${JSON.stringify(exported, null, 2)}\n`;
}

export function decryptRecoveryExport(serialized, exportPassphrase) {
  let exported;
  try {
    exported = validateRecoveryExport(typeof serialized === "string" ? JSON.parse(serialized) : serialized);
  } catch (error) {
    if (error instanceof SyntaxError) fail("The recovery export is not valid JSON.");
    throw error;
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(exportPassphrase, Buffer.from(exported.salt, "base64")),
      Buffer.from(exported.iv, "base64"),
    );
    decipher.setAAD(aad(exported));
    decipher.setAuthTag(Buffer.from(exported.authTag, "base64"));
    return requireSecret(
      Buffer.concat([
        decipher.update(Buffer.from(exported.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
      "The recovered backup secret",
    );
  } catch {
    fail("The recovery export passphrase or authenticated metadata is incorrect.");
  }
}
