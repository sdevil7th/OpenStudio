/**
 * Join a filename to a directory selected by the native file dialog without
 * imposing Windows separators on macOS/Linux or rewriting Windows UNC paths.
 */
export function joinNativePath(directory: string, fileName: string): string {
  const cleanFileName = fileName.replace(/^[\\/]+/, "");
  if (!directory) return cleanFileName;

  const cleanDirectory = directory.replace(/[\\/]+$/, "");
  const separator = cleanDirectory.includes("\\") && !cleanDirectory.includes("/")
    ? "\\"
    : "/";
  return `${cleanDirectory}${separator}${cleanFileName}`;
}
