import fs from "node:fs";
import path from "node:path";

export function findExecutable(
  name,
  {
    pathValue = process.env.PATH ?? "",
    platform = process.platform,
    fileExists = fs.existsSync,
  } = {},
) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
  const executableNames = platform === "win32" && !name.toLowerCase().endsWith(".exe")
    ? [name, `${name}.exe`]
    : [name];

  for (const directory of pathValue.split(pathDelimiter)) {
    for (const executableName of executableNames) {
      const candidate = pathApi.join(directory, executableName);
      if (fileExists(candidate)) return candidate;
    }
  }

  throw new Error(`Required local test executable was not found: ${name}`);
}
