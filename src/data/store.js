import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEED_ACTIVITIES,
  SEED_MASTER_ENTITIES,
  SEED_SALES_PEOPLE,
  SEED_USERS,
} from "./seed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_FILE = path.resolve(__dirname, "../../data/runtime.json");

function createInitialState() {
  return {
    users: structuredClone(SEED_USERS),
    salesPeople: structuredClone(SEED_SALES_PEOPLE),
    masterEntities: structuredClone(SEED_MASTER_ENTITIES),
    activities: structuredClone(SEED_ACTIVITIES),
  };
}

let memoryStore = null;

function isTestMode() {
  return process.env.NODE_ENV === "test";
}

export function getStore() {
  if (memoryStore) {
    return memoryStore;
  }

  if (!isTestMode() && fs.existsSync(RUNTIME_FILE)) {
    try {
      const raw = fs.readFileSync(RUNTIME_FILE, "utf-8");
      memoryStore = JSON.parse(raw);
      return memoryStore;
    } catch {
      // Fallback to fresh seed if runtime JSON is corrupted
    }
  }

  memoryStore = createInitialState();
  saveStore(memoryStore);
  return memoryStore;
}

export function saveStore(store = memoryStore) {
  memoryStore = store;
  if (isTestMode()) {
    return;
  }
  fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export function resetStore() {
  const fresh = createInitialState();
  memoryStore = fresh;
  saveStore(fresh);
  return fresh;
}

