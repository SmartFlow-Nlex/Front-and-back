export {};

declare global {
  interface Window {
    desktopApp?: {
      platform: string;
      version: string;
    };
  }
}
