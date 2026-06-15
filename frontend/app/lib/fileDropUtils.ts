export interface FileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

export interface FileSystemFileEntry extends FileSystemEntry {
  isFile: true;
  isDirectory: false;
  file: (
    callback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
}

export interface FileSystemDirectoryReader {
  readEntries: (
    callback: (entries: FileSystemEntry[]) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
}

export interface FileSystemDirectoryEntry extends FileSystemEntry {
  isFile: false;
  isDirectory: true;
  createReader: () => FileSystemDirectoryReader;
}

export type DataTransferItemWithEntry = Omit<
  DataTransferItem,
  "webkitGetAsEntry"
> & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

export function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

export function readDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

export async function flattenEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return [await readFileEntry(entry as FileSystemFileEntry)];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: File[] = [];

  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (!entries.length) break;

    const nestedFiles = await Promise.all(
      entries.map((nestedEntry) => flattenEntry(nestedEntry)),
    );
    files.push(...nestedFiles.flat());
  }

  return files;
}

export async function getDroppedFiles(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = Array.from(
    dataTransfer.items ?? [],
  ) as DataTransferItemWithEntry[];

  if (!items.length) {
    return Array.from(dataTransfer.files);
  }

  const files = await Promise.all(
    items
      .filter((item) => item.kind === "file")
      .map(async (item) => {
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          return flattenEntry(entry);
        }

        const file = item.getAsFile();
        return file ? [file] : [];
      }),
  );

  return files.flat();
}
