// Abstraction over "where do files come from". In the desktop app this talks to
// Electron's main process. In a plain browser (used for development/testing)
// it falls back to file pickers, downloads and localStorage.

export interface OpenedFile {
  name: string;
  path?: string;
  data: Uint8Array;
}

export interface SavedSignature {
  id: string;
  dataUrl: string;
  created: number;
}

interface DesktopApi {
  openPdfs(multiple: boolean): Promise<OpenedFile[]>;
  openImage(): Promise<{ name: string; dataUrl: string } | null>;
  savePdfAs(suggestedName: string, data: Uint8Array): Promise<{ path: string; name: string } | null>;
  writePdf(filePath: string, data: Uint8Array): Promise<{ path: string; name: string }>;
  initialFile(): Promise<OpenedFile | null>;
  listSignatures(): Promise<SavedSignature[]>;
  saveSignature(dataUrl: string): Promise<string>;
  deleteSignature(id: string): Promise<void>;
  confirmClose(): Promise<void>;
  onMenu(cb: (cmd: string) => void): () => void;
  onOpenFile(cb: (f: OpenedFile) => void): () => void;
  onCloseRequested(cb: () => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export const isDesktop = () => !!window.desktop;

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

const fileToDataUrl = (f: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

const SIG_KEY = 'nour-pdf-signatures';
function readLocalSigs(): SavedSignature[] {
  try {
    return JSON.parse(localStorage.getItem(SIG_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export const platform = {
  async openPdfs(multiple: boolean): Promise<OpenedFile[]> {
    if (window.desktop) return window.desktop.openPdfs(multiple);
    const files = await pickFiles('application/pdf,.pdf', multiple);
    return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  },

  async openImage(): Promise<string | null> {
    if (window.desktop) return (await window.desktop.openImage())?.dataUrl ?? null;
    const [f] = await pickFiles('image/*', false);
    return f ? fileToDataUrl(f) : null;
  },

  fileToDataUrl,

  async saveAs(suggestedName: string, data: Uint8Array): Promise<{ path?: string; name: string } | null> {
    if (window.desktop) return window.desktop.savePdfAs(suggestedName, data);
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { name: suggestedName };
  },

  async write(path: string, data: Uint8Array) {
    if (!window.desktop) throw new Error('not available');
    return window.desktop.writePdf(path, data);
  },

  async listSignatures(): Promise<SavedSignature[]> {
    if (window.desktop) return window.desktop.listSignatures();
    return readLocalSigs();
  },

  async saveSignature(dataUrl: string): Promise<void> {
    if (window.desktop) {
      await window.desktop.saveSignature(dataUrl);
      return;
    }
    const list = readLocalSigs();
    list.unshift({ id: crypto.randomUUID(), dataUrl, created: Date.now() });
    try {
      localStorage.setItem(SIG_KEY, JSON.stringify(list));
    } catch {
      /* storage full or blocked */
    }
  },

  async deleteSignature(id: string): Promise<void> {
    if (window.desktop) return window.desktop.deleteSignature(id);
    try {
      localStorage.setItem(SIG_KEY, JSON.stringify(readLocalSigs().filter((s) => s.id !== id)));
    } catch {
      /* ignore */
    }
  },
};
