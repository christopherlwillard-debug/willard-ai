import * as fs from "node:fs";
import * as path from "node:path";

const PROC_FD_ROOT = "/proc/self/fd";

export interface SafeListedDirectoryEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;
  fileCount: number | null;
}

export interface SafeDirectoryReadHooks {
  afterRootOpened?: () => void;
  afterTargetOpened?: () => void;
  afterEntriesRead?: () => void;
  afterParentOpened?: () => void;
}

export interface SafeOpenedRegularFile {
  fd: number;
  stat: fs.Stats;
}

function descriptorPath(fd: number): string {
  return path.join(PROC_FD_ROOT, String(fd));
}

function directoryOpenFlags(): number {
  return fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);
}

function openAbsoluteDirectoryWithoutLinks(absolutePath: string): number {
  const parsed = path.parse(absolutePath);
  let currentFd = fs.openSync(parsed.root, directoryOpenFlags());
  try {
    const components = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const component of components) {
      if (component === "." || component === ".." || component.includes(path.sep)) {
        throw new Error("Unsafe directory component.");
      }
      const nextFd = fs.openSync(path.join(descriptorPath(currentFd), component), directoryOpenFlags());
      fs.closeSync(currentFd);
      currentFd = nextFd;
    }
    return currentFd;
  } catch (error) {
    fs.closeSync(currentFd);
    throw error;
  }
}

function openRelativeDirectoryWithoutLinks(rootFd: number, relativePath: string): number {
  // The /proc/self/fd/<n> element is itself a trusted procfs symlink to an
  // already-open descriptor. Follow it; O_NOFOLLOW applies to each child
  // component opened beneath that descriptor.
  let currentFd = fs.openSync(
    descriptorPath(rootFd),
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    const components = relativePath.split(path.sep).filter(Boolean);
    for (const component of components) {
      if (component === "." || component === ".." || component.includes(path.sep)) {
        throw new Error("Unsafe directory component.");
      }
      const nextFd = fs.openSync(path.join(descriptorPath(currentFd), component), directoryOpenFlags());
      fs.closeSync(currentFd);
      currentFd = nextFd;
    }
    return currentFd;
  } catch (error) {
    fs.closeSync(currentFd);
    throw error;
  }
}

/**
 * Enumerate one directory through open directory descriptors. On Linux, every
 * path component is opened relative to the already-open parent and with
 * O_NOFOLLOW, so swapping a NAS directory for a symlink cannot redirect a
 * later enumeration outside the configured root. Returns null on platforms
 * without procfs descriptor paths; callers must use their platform policy.
 */
export function readDirectoryWithoutSymlinkTraversal(
  configuredRoot: string,
  requestedDirectory: string,
  hooks: SafeDirectoryReadHooks = {},
): { canonicalRoot: string; entries: SafeListedDirectoryEntry[] } | null {
  if (process.platform !== "linux" || !fs.existsSync(PROC_FD_ROOT)) return null;

  const canonicalRoot = fs.realpathSync(configuredRoot);
  const lexicalRoot = path.resolve(configuredRoot);
  const relativePath = path.relative(lexicalRoot, path.resolve(requestedDirectory));
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Requested directory is outside the configured root.");
  }

  let rootFd: number | undefined;
  let targetFd: number | undefined;
  try {
    rootFd = openAbsoluteDirectoryWithoutLinks(canonicalRoot);
    hooks.afterRootOpened?.();
    targetFd = openRelativeDirectoryWithoutLinks(rootFd, relativePath);
    hooks.afterTargetOpened?.();

    const targetDescriptorPath = descriptorPath(targetFd);
    const dirents = fs.readdirSync(targetDescriptorPath, { withFileTypes: true });
    hooks.afterEntriesRead?.();
    const entries: SafeListedDirectoryEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name === "." || dirent.name === ".." || dirent.name.includes(path.sep)) continue;
      const entryPath = path.join(targetDescriptorPath, dirent.name);
      let entryFd: number | undefined;
      try {
        if (dirent.isDirectory()) {
          entryFd = fs.openSync(entryPath, directoryOpenFlags());
          const stat = fs.fstatSync(entryFd);
          if (!stat.isDirectory()) continue;
          entries.push({
            name: dirent.name,
            isDirectory: true,
            sizeBytes: 0,
            modifiedAt: stat.mtime.toISOString(),
            fileCount: fs.readdirSync(descriptorPath(entryFd)).length,
          });
        } else if (dirent.isFile()) {
          entryFd = fs.openSync(
            entryPath,
            fs.constants.O_RDONLY |
              (fs.constants.O_NOFOLLOW ?? 0) |
              (fs.constants.O_NONBLOCK ?? 0),
          );
          const stat = fs.fstatSync(entryFd);
          if (!stat.isFile()) continue;
          entries.push({
            name: dirent.name,
            isDirectory: false,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            fileCount: null,
          });
        }
      } catch {
        // Entries that disappear or become links/special files during the
        // listing are omitted rather than followed or treated as regular.
      } finally {
        if (entryFd !== undefined) fs.closeSync(entryFd);
      }
    }
    return { canonicalRoot, entries };
  } finally {
    if (targetFd !== undefined) fs.closeSync(targetFd);
    if (rootFd !== undefined) fs.closeSync(rootFd);
  }
}

/**
 * Remove an empty directory relative to an already-open, no-follow parent.
 * Returns null when handle-relative operations are unavailable on this
 * platform; callers must apply their platform-specific policy in that case.
 */
export function removeEmptyDirectoryWithoutSymlinkTraversal(
  configuredRoot: string,
  targetDirectory: string,
  hooks: SafeDirectoryReadHooks = {},
): boolean | null {
  if (process.platform !== "linux" || !fs.existsSync(PROC_FD_ROOT)) return null;

  const relativePath = path.relative(path.resolve(configuredRoot), path.resolve(targetDirectory));
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Requested directory is outside the configured root.");
  }
  if (!relativePath || relativePath === ".") return false;

  const components = relativePath.split(path.sep).filter(Boolean);
  const leaf = components.pop();
  if (!leaf || leaf === "." || leaf === "..") {
    throw new Error("Requested directory is not a removable child.");
  }

  let rootFd: number | undefined;
  let parentFd: number | undefined;
  try {
    rootFd = openAbsoluteDirectoryWithoutLinks(fs.realpathSync(configuredRoot));
    parentFd = openRelativeDirectoryWithoutLinks(rootFd, components.join(path.sep));
    hooks.afterParentOpened?.();
    fs.rmdirSync(path.join(descriptorPath(parentFd), leaf));
    return true;
  } finally {
    if (parentFd !== undefined) fs.closeSync(parentFd);
    if (rootFd !== undefined) fs.closeSync(rootFd);
  }
}

/**
 * Open one regular file beneath an already-authorized root. Parent directories
 * and the final file are opened from held descriptors with O_NOFOLLOW, so a
 * symlink replacement cannot redirect the read outside the root.
 */
export function openRegularFileWithoutSymlinkTraversal(
  configuredRoot: string,
  requestedPath: string,
  hooks: SafeDirectoryReadHooks = {},
): SafeOpenedRegularFile | null {
  if (process.platform !== "linux" || !fs.existsSync(PROC_FD_ROOT)) return null;
  const lexicalRoot = path.resolve(configuredRoot);
  const canonicalRoot = fs.realpathSync(configuredRoot);
  const isInside = (relative: string) =>
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`);
  const relativePath = path.isAbsolute(requestedPath)
    ? (() => {
      const absoluteRequest = path.resolve(requestedPath);
      const canonicalRelative = path.relative(canonicalRoot, absoluteRequest);
      if (isInside(canonicalRelative)) return canonicalRelative;
      return path.relative(lexicalRoot, absoluteRequest);
    })()
    : path.relative(lexicalRoot, path.resolve(lexicalRoot, requestedPath.replace(/\\/g, path.sep)));
  if (
    !relativePath ||
    relativePath === "." ||
    !isInside(relativePath)
  ) {
    throw new Error("Requested file is outside the configured root.");
  }

  const components = relativePath.split(path.sep).filter(Boolean);
  if (components.some((component) => component === "." || component === ".." || component.includes("\0"))) {
    throw new Error("Requested file contains an unsafe path component.");
  }
  const leaf = components.pop();
  if (!leaf) throw new Error("Requested file path is incomplete.");

  let rootFd: number | undefined;
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    rootFd = openAbsoluteDirectoryWithoutLinks(canonicalRoot);
    parentFd = openRelativeDirectoryWithoutLinks(rootFd, components.join(path.sep));
    hooks.afterParentOpened?.();
    fileFd = fs.openSync(
      path.join(descriptorPath(parentFd), leaf),
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile()) throw new Error("Requested path is not a regular file.");
    const result = { fd: fileFd, stat };
    fileFd = undefined;
    return result;
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    if (parentFd !== undefined) fs.closeSync(parentFd);
    if (rootFd !== undefined) fs.closeSync(rootFd);
  }
}
