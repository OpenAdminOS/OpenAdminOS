import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (!window.HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
}

if (!window.HTMLElement.prototype.animate) {
 Object.defineProperty(window.HTMLElement.prototype,"animate",{configurable:true,value:()=>({cancel(){},onfinish:null})});
}
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// Node 26 ships an experimental Web Storage global that shadows the
// jsdom one and stays undefined unless --localstorage-file is passed,
// which broke every renderer test locally while CI (Node 22) stayed
// green. Install a small in-memory Storage when the environment one is
// unusable so the suite runs on both.
function ensureStorage(name: "localStorage" | "sessionStorage") {
  let usable = false;
  try {
    usable = typeof window[name]?.clear === "function";
    if (usable) window[name].getItem("__oa_probe__");
  } catch {
    usable = false;
  }
  if (usable) return;
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
  Object.defineProperty(window, name, { configurable: true, value: storage });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.openAdminOS = undefined;
});
