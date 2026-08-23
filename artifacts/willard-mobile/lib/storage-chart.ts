export type StorageTypeBreakdown = {
  fileType: string;
  sizeBytes: number;
  percentage: number;
};

export type StorageFolder = {
  folder: string;
  totalSizeBytes: number;
};

export type StorageChartState = "loading" | "unavailable" | "empty" | "ready";

type QueryState<T> = {
  isLoading: boolean;
  isError: boolean;
  data?: T | null;
};

export function getStorageChartState<T>(
  query: QueryState<T>,
  hasRows: (data: T | null | undefined) => boolean,
): StorageChartState {
  if (query.isLoading) return "loading";
  if (query.isError) return "unavailable";
  if (!hasRows(query.data)) return "empty";
  return "ready";
}

export function typeBarWidth(percentage: number, sizeBytes: number): number {
  if (!Number.isFinite(percentage) || percentage <= 0) return 0;
  return Math.min(100, Math.max(percentage, sizeBytes > 0 ? 1 : 0));
}

export function folderBarWidth(sizeBytes: number, largestSizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 0;
  const denominator = Number.isFinite(largestSizeBytes) && largestSizeBytes > 0 ? largestSizeBytes : 1;
  return Math.min(100, Math.max((sizeBytes / denominator) * 100, 1));
}

export function topFolders(folders: StorageFolder[], limit = 10): StorageFolder[] {
  return folders.slice(0, Math.max(0, limit));
}