/** Stage completed ZIP parts on browser-managed disk, not in a growing JS heap. */
export class ArchiveStorage {
  private directory: FileSystemDirectoryHandle | undefined;
  private name = '';
  private urls: string[] = [];
  private fallbackBytes = 0;
  async add(blob: Blob, name: string): Promise<string> {
    let download: Blob = blob;
    if (navigator.storage?.getDirectory) {
      if (!this.directory) {
        const root = await navigator.storage.getDirectory();
        this.name = `teditor-export-${Date.now()}-${crypto.randomUUID()}`;
        this.directory = await root.getDirectoryHandle(this.name, { create: true });
      }
      const file = await this.directory.getFileHandle(name, { create: true });
      const writer = await file.createWritable();
      try {
        await writer.write(blob);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
      download = await file.getFile();
    } else {
      this.fallbackBytes += blob.size;
      if (this.fallbackBytes > 128 * 1024 * 1024)
        throw new Error('ZIP 数据超过当前浏览器内存下载上限，请改用目录导出或缩小行范围');
    }
    const url = URL.createObjectURL(download);
    this.urls.push(url);
    return url;
  }
  async clear() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.fallbackBytes = 0;
    if (this.directory) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(this.name, { recursive: true });
      this.directory = undefined;
      this.name = '';
    }
  }
}
