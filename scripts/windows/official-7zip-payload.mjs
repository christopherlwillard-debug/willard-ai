import { access, copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Copy only the pinned official Windows 7-Zip executable and its required
 * DLL into the release payload. The cross-platform npm package is not shipped.
 */
export async function copyOfficialWindows7Zip(sourceExecutable, destinationDirectory) {
  const source = path.resolve(sourceExecutable);
  if (path.basename(source).toLowerCase() !== "7z.exe") {
    throw new Error("Official Windows 7-Zip source must be the verified 7z.exe executable.");
  }

  const sourceDll = path.join(path.dirname(source), "7z.dll");
  await access(source);
  await access(sourceDll);

  const destination = path.resolve(destinationDirectory);
  await mkdir(destination, { recursive: true });
  const executablePath = path.join(destination, "7z.exe");
  const dllPath = path.join(destination, "7z.dll");
  await copyFile(source, executablePath);
  await copyFile(sourceDll, dllPath);

  const [executableInfo, dllInfo] = await Promise.all([stat(executablePath), stat(dllPath)]);
  if (!executableInfo.isFile() || executableInfo.size === 0 || !dllInfo.isFile() || dllInfo.size === 0) {
    throw new Error("Official Windows 7-Zip payload copy is incomplete.");
  }

  return { executablePath, dllPath };
}
