import { describe, it, expect, vi } from "vitest";
import {
  readFileEntry,
  readDirectoryEntries,
  flattenEntry,
  getDroppedFiles,
  type FileSystemEntry,
  type FileSystemFileEntry,
  type FileSystemDirectoryEntry,
  type FileSystemDirectoryReader,
} from "@/app/lib/fileDropUtils";

const makeFile = (name: string) => new File(["content"], name, { type: "text/plain" });

function makeFileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (cb) => cb(file),
  };
}

function makeDirEntry(
  name: string,
  batches: FileSystemEntry[][],
): FileSystemDirectoryEntry {
  let callCount = 0;
  const reader: FileSystemDirectoryReader = {
    readEntries: (cb) => {
      cb(batches[callCount] ?? []);
      callCount++;
    },
  };
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => reader,
  };
}

describe("readFileEntry", () => {
  it("resolves with the File object", async () => {
    const file = makeFile("hello.txt");
    const result = await readFileEntry(makeFileEntry(file));
    expect(result).toBe(file);
  });

  it("rejects when the entry calls errorCallback", async () => {
    const entry: FileSystemFileEntry = {
      isFile: true,
      isDirectory: false,
      name: "bad.txt",
      file: (_cb, errCb) => errCb?.(new DOMException("read error")),
    };
    await expect(readFileEntry(entry)).rejects.toThrow("read error");
  });
});

describe("readDirectoryEntries", () => {
  it("resolves with the entries array", async () => {
    const file = makeFile("a.txt");
    const entries: FileSystemEntry[] = [makeFileEntry(file)];
    const reader: FileSystemDirectoryReader = {
      readEntries: (cb) => cb(entries),
    };
    const result = await readDirectoryEntries(reader);
    expect(result).toBe(entries);
  });

  it("rejects when errorCallback is invoked", async () => {
    const reader: FileSystemDirectoryReader = {
      readEntries: (_cb, errCb) => errCb?.(new DOMException("dir error")),
    };
    await expect(readDirectoryEntries(reader)).rejects.toThrow("dir error");
  });
});

describe("flattenEntry", () => {
  it("returns single file for a file entry", async () => {
    const file = makeFile("doc.pdf");
    const result = await flattenEntry(makeFileEntry(file));
    expect(result).toEqual([file]);
  });

  it("returns empty array for an entry that is neither file nor directory", async () => {
    const weird: FileSystemEntry = { isFile: false, isDirectory: false, name: "weird" };
    expect(await flattenEntry(weird)).toEqual([]);
  });

  it("recursively collects files from a directory", async () => {
    const a = makeFile("a.txt");
    const b = makeFile("b.txt");
    const dirEntry = makeDirEntry("mydir", [
      [makeFileEntry(a), makeFileEntry(b)],
      [],
    ]);
    const result = await flattenEntry(dirEntry);
    expect(result).toEqual([a, b]);
  });

  it("handles nested directories", async () => {
    const inner = makeFile("inner.txt");
    const outer = makeFile("outer.txt");

    const innerDir = makeDirEntry("inner", [[makeFileEntry(inner)], []]);
    const outerDir = makeDirEntry("outer", [[makeFileEntry(outer), innerDir], []]);

    const result = await flattenEntry(outerDir);
    expect(result).toEqual([outer, inner]);
  });

  it("handles empty directory (no files)", async () => {
    const emptyDir = makeDirEntry("empty", [[]]);
    expect(await flattenEntry(emptyDir)).toEqual([]);
  });
});

describe("getDroppedFiles", () => {
  it("falls back to dataTransfer.files when items is empty", async () => {
    const file = makeFile("drop.txt");
    const dt = {
      items: [],
      files: [file],
    } as unknown as DataTransfer;
    const result = await getDroppedFiles(dt);
    expect(result).toEqual([file]);
  });

  it("uses webkitGetAsEntry to flatten file entries", async () => {
    const file = makeFile("entry.txt");
    const entry = makeFileEntry(file);
    const item = {
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => file,
    };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    const result = await getDroppedFiles(dt);
    expect(result).toEqual([file]);
  });

  it("falls back to getAsFile when webkitGetAsEntry is absent", async () => {
    const file = makeFile("plain.txt");
    const item = { kind: "file", webkitGetAsEntry: undefined, getAsFile: () => file };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    const result = await getDroppedFiles(dt);
    expect(result).toEqual([file]);
  });

  it("skips items where webkitGetAsEntry returns null and getAsFile returns null", async () => {
    const item = { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => null };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    expect(await getDroppedFiles(dt)).toEqual([]);
  });

  it("ignores non-file items", async () => {
    const item = { kind: "string", webkitGetAsEntry: vi.fn(), getAsFile: vi.fn() };
    const dt = { items: [item], files: [] } as unknown as DataTransfer;
    expect(await getDroppedFiles(dt)).toEqual([]);
  });

  it("handles dataTransfer with no items property", async () => {
    const file = makeFile("noitems.txt");
    const dt = { items: undefined, files: [file] } as unknown as DataTransfer;
    expect(await getDroppedFiles(dt)).toEqual([file]);
  });
});
