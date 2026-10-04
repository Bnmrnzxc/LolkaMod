declare namespace NodeJS {
  interface Process {
    resourcesPath: string;
    isMainFrame: boolean;
    sandboxed: boolean;
    contextIsolated: boolean;
  }
}
