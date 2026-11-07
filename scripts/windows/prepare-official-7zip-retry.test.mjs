import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./prepare-official-7zip.ps1", import.meta.url));
const script = readFileSync(scriptPath, "utf8");
const start = script.indexOf("function Download-And-Verify(");
const end = script.indexOf("\n}\n\nfunction Assert-SafeEmptyDestination", start);
const downloadFunction = script.slice(start, end < 0 ? script.length : end + 2);

test("official Windows 7-Zip downloads retry transient failures and fall back to the pinned SourceForge mirror", () => {
  assert.ok(start >= 0 && end > start, "Download-And-Verify should be present");
  assert.match(downloadFunction, /\$MaxAttemptsPerSource = 2/);
  assert.match(downloadFunction, /foreach \(\$Source in \$Sources\)/);
  assert.match(downloadFunction, /for \(\$Attempt = 1; \$Attempt -le \$MaxAttemptsPerSource; \$Attempt\+\+\)/);
  assert.match(downloadFunction, /Invoke-WebRequest -UseBasicParsing -Uri \$Source\.Url/);
  assert.match(downloadFunction, /Remove-Item -LiteralPath \$Path -Force -ErrorAction SilentlyContinue/);
  assert.match(downloadFunction, /\[Math\]::Min\(2 \* \[Math\]::Pow\(2, \$Attempt - 1\), 8\)/);
  assert.match(downloadFunction, /Start-Sleep -Seconds \$DelaySeconds/);
  assert.match(downloadFunction, /official 7-Zip SourceForge mirror/);
  assert.match(script, /\$SourceForgeBase = "https:\/\/sourceforge\.net\/projects\/sevenzip\/files\/7-Zip\/26\.05"/);
  assert.ok(downloadFunction.indexOf('Name = "GitHub"') < downloadFunction.indexOf('Name = "SourceForge"'), "GitHub must remain the primary source");
  assert.match(downloadFunction, /Unable to download \$Name from the pinned GitHub release or SourceForge mirror/);
});

test("official Windows 7-Zip checksum verification remains strict and outside the retry loop", () => {
  const exhausted = downloadFunction.indexOf("if (-not $Downloaded)");
  const hash = downloadFunction.indexOf("$ActualHash =");
  assert.ok(exhausted >= 0 && hash > exhausted, "hash verification must happen only after a successful download");
  assert.match(downloadFunction, /SHA-256 verification failed for \$Name/);
  assert.match(downloadFunction, /A checksum mismatch is an integrity failure/);
});
