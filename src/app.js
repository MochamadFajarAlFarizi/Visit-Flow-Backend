import express from "express";
import cors from "cors";
import { getStore, saveStore } from "./data/store.js";
import {
  isSuperAdmin,
  requireAuth,
  requireSuperAdmin,
  signToken,
} from "./middleware/auth.js";

const VALID_SEGMENTS = ["B2G", "B2B"];
const VALID_STATUSES = ["VISITED", "NOT_VISITED"];
const VALID_ROLES = ["SUPER_ADMIN", "SALES"];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value) {
  if (typeof value !== "string" || !DATE_REGEX.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function canAccessActivity(user, activity) {
  if (isSuperAdmin(user)) {
    return true;
  }
  if (activity.userId && activity.userId === user.id) {
    return true;
  }
  return (
    (activity.salesName || "").trim().toLowerCase() ===
    (user.name || "").trim().toLowerCase()
  );
}

function buildEntityCatalog(store, user) {
  const dedupeMap = new Map();

  for (const entity of store.masterEntities) {
    const key = `${entity.name.trim().toLowerCase()}__${entity.type.trim().toLowerCase()}__${entity.segment}`;
    if (!dedupeMap.has(key)) {
      dedupeMap.set(key, {
        ...entity,
        source: "MASTER",
      });
    }
  }

  for (const act of store.activities) {
    if (user && !canAccessActivity(user, act)) {
      continue;
    }
    const typeLabel = act.entityType || "Entitas Kunjungan";
    const key = `${act.entityName.trim().toLowerCase()}__${typeLabel.trim().toLowerCase()}__${act.segment}`;
    if (!dedupeMap.has(key)) {
      dedupeMap.set(key, {
        id: act.entityId,
        name: act.entityName,
        type: typeLabel,
        segment: act.segment,
        region: act.region,
        source: "HISTORY",
      });
    }
  }

  return Array.from(dedupeMap.values());
}

function formatEntitiesWithDisambiguation(entities) {
  const nameCounts = new Map();
  for (const entity of entities) {
    const normalizedName = entity.name.trim().toLowerCase();
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) || 0) + 1);
  }

  return entities.map((entity) => {
    const count = nameCounts.get(entity.name.trim().toLowerCase()) || 0;
    const hasSimilarName = count > 1;
    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      segment: entity.segment,
      region: entity.region,
      source: entity.source,
      hasSimilarName,
      displayName: `${entity.name} — ${entity.type} (${entity.region})`,
    };
  });
}

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "visit-flow-backend" });
  });

  // Public auth endpoints
  app.get("/api/auth/demo-accounts", (_req, res) => {
    const store = getStore();
    const accounts = store.users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      password: u.password,
      role: u.role,
      region: u.region,
    }));
    res.json({ data: accounts });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({
        error: "Email dan password wajib diisi.",
      });
    }

    const store = getStore();
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = store.users.find(
      (u) => u.email.toLowerCase() === normalizedEmail && u.password === password
    );

    if (!user) {
      return res.status(401).json({
        error: "Email atau password salah.",
      });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        region: user.region,
      },
    });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // Super Admin RBAC: User Account Management
  app.get("/api/users", requireAuth, requireSuperAdmin, (_req, res) => {
    const store = getStore();
    const safeUsers = store.users.map(({ password: _pw, ...safe }) => safe);
    res.json({ data: safeUsers });
  });

  app.post("/api/users", requireAuth, requireSuperAdmin, (req, res) => {
    const { name, email, password, role, region } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Nama wajib diisi." });
    }
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: "Email wajib diisi." });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({
        error: "Password wajib diisi dan minimal 6 karakter.",
      });
    }
    if (!region || !String(region).trim()) {
      return res.status(400).json({ error: "Wilayah wajib diisi." });
    }

    const resolvedRole = role ? String(role).trim() : "SALES";
    if (!VALID_ROLES.includes(resolvedRole)) {
      return res.status(400).json({
        error: "Role tidak valid. Gunakan SUPER_ADMIN atau SALES.",
      });
    }

    const store = getStore();
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = store.users.find(
      (u) => u.email.toLowerCase() === normalizedEmail
    );
    if (existing) {
      return res.status(400).json({ error: "Email sudah terdaftar." });
    }

    const cleanName = String(name).trim();
    const newUser = {
      id: `usr-${String(store.users.length + 1).padStart(3, "0")}-${Date.now().toString().slice(-4)}`,
      name: cleanName,
      email: normalizedEmail,
      password: String(password),
      role: resolvedRole,
      region: String(region).trim(),
    };

    store.users.push(newUser);
    if (!store.salesPeople.includes(cleanName)) {
      store.salesPeople.push(cleanName);
    }
    saveStore(store);

    const { password: _pw, ...safeUser } = newUser;
    return res.status(201).json(safeUser);
  });

  function handleUpdateUser(req, res) {
    const { id } = req.params;
    const { name, email, password, role, region } = req.body || {};

    const store = getStore();
    const targetUser = store.users.find((u) => u.id === id);
    if (!targetUser) {
      return res.status(404).json({ error: "Akun pengguna tidak ditemukan." });
    }

    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: "Nama wajib diisi." });
    }
    if (email !== undefined && !String(email).trim()) {
      return res.status(400).json({ error: "Email wajib diisi." });
    }
    if (region !== undefined && !String(region).trim()) {
      return res.status(400).json({ error: "Wilayah wajib diisi." });
    }
    if (
      password !== undefined &&
      String(password) !== "" &&
      String(password).length < 6
    ) {
      return res.status(400).json({
        error: "Password baru minimal 6 karakter.",
      });
    }

    const nextRole =
      role !== undefined ? String(role).trim() : targetUser.role;
    if (!VALID_ROLES.includes(nextRole)) {
      return res.status(400).json({
        error: "Role tidak valid. Gunakan SUPER_ADMIN atau SALES.",
      });
    }

    if (targetUser.role === "SUPER_ADMIN" && nextRole !== "SUPER_ADMIN") {
      const superAdminCount = store.users.filter(
        (u) => u.role === "SUPER_ADMIN"
      ).length;
      if (superAdminCount <= 1) {
        return res.status(400).json({
          error: "Minimal harus ada 1 akun SUPER_ADMIN aktif di sistem.",
        });
      }
    }

    const nextEmail =
      email !== undefined
        ? String(email).trim().toLowerCase()
        : targetUser.email;
    const emailConflict = store.users.find(
      (u) => u.id !== targetUser.id && u.email.toLowerCase() === nextEmail
    );
    if (emailConflict) {
      return res.status(400).json({ error: "Email sudah digunakan akun lain." });
    }

    const oldName = targetUser.name;
    const nextName =
      name !== undefined ? String(name).trim() : targetUser.name;

    targetUser.name = nextName;
    targetUser.email = nextEmail;
    targetUser.role = nextRole;
    if (region !== undefined) {
      targetUser.region = String(region).trim();
    }
    if (password !== undefined && String(password) !== "") {
      targetUser.password = String(password);
    }

    if (oldName !== nextName) {
      store.salesPeople = store.salesPeople.map((s) =>
        s.trim().toLowerCase() === oldName.trim().toLowerCase() ? nextName : s
      );
      if (!store.salesPeople.includes(nextName)) {
        store.salesPeople.push(nextName);
      }
      for (const act of store.activities) {
        if (
          act.userId === targetUser.id ||
          (act.salesName || "").trim().toLowerCase() ===
            oldName.trim().toLowerCase()
        ) {
          act.salesName = nextName;
        }
      }
    }

    saveStore(store);
    const { password: _pw, ...safeUser } = targetUser;
    return res.json(safeUser);
  }

  app.put("/api/users/:id", requireAuth, requireSuperAdmin, handleUpdateUser);
  app.patch("/api/users/:id", requireAuth, requireSuperAdmin, handleUpdateUser);

  app.delete("/api/users/:id", requireAuth, requireSuperAdmin, (req, res) => {
    const { id } = req.params;
    const store = getStore();
    const index = store.users.findIndex((u) => u.id === id);

    if (index === -1) {
      return res.status(404).json({ error: "Akun pengguna tidak ditemukan." });
    }

    const targetUser = store.users[index];
    if (targetUser.id === req.user.id) {
      return res.status(400).json({
        error: "Tidak dapat menghapus akun yang sedang Anda gunakan.",
      });
    }

    if (targetUser.role === "SUPER_ADMIN") {
      const superAdminCount = store.users.filter(
        (u) => u.role === "SUPER_ADMIN"
      ).length;
      if (superAdminCount <= 1) {
        return res.status(400).json({
          error: "Minimal harus ada 1 akun SUPER_ADMIN aktif di sistem.",
        });
      }
    }

    store.users.splice(index, 1);

    const hasActivities = store.activities.some(
      (act) =>
        (act.salesName || "").trim().toLowerCase() ===
        targetUser.name.trim().toLowerCase()
    );
    if (!hasActivities) {
      store.salesPeople = store.salesPeople.filter(
        (s) =>
          s.trim().toLowerCase() !== targetUser.name.trim().toLowerCase()
      );
    }

    saveStore(store);
    return res.json({ deleted: true, id: targetUser.id });
  });

  // Protected sales list endpoint scoped by RBAC
  app.get("/api/sales", requireAuth, (req, res) => {
    if (!isSuperAdmin(req.user)) {
      return res.json({ data: [req.user.name] });
    }

    const store = getStore();
    const set = new Set(store.salesPeople);
    for (const user of store.users) {
      if (user.name && user.name.trim()) {
        set.add(user.name.trim());
      }
    }
    for (const act of store.activities) {
      if (act.salesName && act.salesName.trim()) {
        set.add(act.salesName.trim());
      }
    }
    return res.json({ data: Array.from(set) });
  });

  // Protected entities endpoint with master + scoped history fallback & deduplication
  app.get("/api/entities", requireAuth, (req, res) => {
    const { segment, search, includeFallback } = req.query;

    if (segment !== undefined && segment !== "" && !VALID_SEGMENTS.includes(segment)) {
      return res.status(400).json({
        error: "Parameter segment tidak valid. Gunakan B2G atau B2B.",
      });
    }

    const store = getStore();
    const searchKeyword =
      typeof search === "string" ? search.trim().toLowerCase() : "";

    const matchesFilter = (entity) => {
      if (segment && entity.segment !== segment) {
        return false;
      }
      if (searchKeyword) {
        const haystack = `${entity.name} ${entity.type} ${entity.region}`.toLowerCase();
        if (!haystack.includes(searchKeyword)) {
          return false;
        }
      }
      return true;
    };

    const allCatalog = buildEntityCatalog(store, req.user);
    const masterMatches = allCatalog.filter(
      (item) => item.source === "MASTER" && matchesFilter(item)
    );
    const historyMatches = allCatalog.filter(
      (item) => item.source === "HISTORY" && matchesFilter(item)
    );

    let selected;
    if (masterMatches.length === 0) {
      // Fallback to scoped visit history when master data has no relevant choices
      selected = historyMatches;
    } else if (includeFallback === "true") {
      selected = [...masterMatches, ...historyMatches];
    } else {
      selected = masterMatches;
    }

    return res.json(formatEntitiesWithDisambiguation(selected));
  });

  // Protected activities list endpoint with RBAC scoping + strict query validation
  app.get("/api/activities", requireAuth, (req, res) => {
    const { segment, status, from, to, search, salesName } = req.query;

    if (segment !== undefined && segment !== "" && !VALID_SEGMENTS.includes(segment)) {
      return res.status(400).json({
        error: "Parameter segment tidak valid. Gunakan B2G atau B2B.",
      });
    }

    if (status !== undefined && status !== "" && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "Parameter status tidak valid. Gunakan VISITED atau NOT_VISITED.",
      });
    }

    if (from !== undefined && from !== "" && !isValidDateString(from)) {
      return res.status(400).json({
        error: "Format tanggal mulai (from) tidak valid. Gunakan YYYY-MM-DD.",
      });
    }

    if (to !== undefined && to !== "" && !isValidDateString(to)) {
      return res.status(400).json({
        error: "Format tanggal akhir (to) tidak valid. Gunakan YYYY-MM-DD.",
      });
    }

    if (from && to && from > to) {
      return res.status(400).json({
        error: "Tanggal mulai (from) tidak boleh lebih besar dari tanggal akhir (to).",
      });
    }

    const store = getStore();
    const searchKeyword =
      typeof search === "string" ? search.trim().toLowerCase() : "";
    const salesKeyword =
      typeof salesName === "string" ? salesName.trim().toLowerCase() : "";

    const filtered = store.activities
      .filter((act) => {
        if (!canAccessActivity(req.user, act)) return false;
        if (segment && act.segment !== segment) return false;
        if (status && act.status !== status) return false;
        if (from && act.visitDate < from) return false;
        if (to && act.visitDate > to) return false;
        if (
          searchKeyword &&
          !act.entityName.toLowerCase().includes(searchKeyword)
        ) {
          return false;
        }
        if (
          salesKeyword &&
          !(act.salesName || "").toLowerCase().includes(salesKeyword)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.visitDate !== b.visitDate) {
          return b.visitDate.localeCompare(a.visitDate);
        }
        return b.id.localeCompare(a.id);
      });

    const summary = {
      total: filtered.length,
      visited: filtered.filter((item) => item.status === "VISITED").length,
      notVisited: filtered.filter((item) => item.status === "NOT_VISITED").length,
      b2g: filtered.filter((item) => item.segment === "B2G").length,
      b2b: filtered.filter((item) => item.segment === "B2B").length,
    };

    return res.json({
      data: filtered,
      summary,
    });
  });

  // Protected create activity endpoint with RBAC ownership enforcement
  app.post("/api/activities", requireAuth, (req, res) => {
    const {
      entityId,
      entityName,
      entityType,
      region,
      segment,
      visitDate,
      salesName,
      notes,
    } = req.body || {};

    const hasEntityId = typeof entityId === "string" && entityId.trim() !== "";
    const hasEntityName =
      typeof entityName === "string" && entityName.trim() !== "";

    if (!hasEntityId && !hasEntityName) {
      return res.status(400).json({
        error: "Nama entitas kunjungan wajib diisi.",
      });
    }

    if (!segment || !VALID_SEGMENTS.includes(segment)) {
      return res.status(400).json({
        error: "Segmen wajib dipilih dan harus bernilai B2G atau B2B.",
      });
    }

    if (!visitDate || !isValidDateString(visitDate)) {
      return res.status(400).json({
        error: "Tanggal kunjungan wajib diisi dengan format YYYY-MM-DD yang valid.",
      });
    }

    if (salesName !== undefined && String(salesName).trim() === "") {
      return res.status(400).json({
        error: "Nama sales tidak boleh kosong.",
      });
    }

    if (
      !isSuperAdmin(req.user) &&
      salesName !== undefined &&
      String(salesName).trim().toLowerCase() !== req.user.name.trim().toLowerCase()
    ) {
      return res.status(403).json({
        error: "Akses ditolak: Anda hanya dapat menambahkan rencana kunjungan untuk diri sendiri.",
      });
    }

    const store = getStore();
    const catalog = buildEntityCatalog(store, req.user);
    let resolvedEntity = null;

    if (hasEntityId) {
      resolvedEntity = catalog.find((item) => item.id === entityId.trim());
      if (!resolvedEntity) {
        return res.status(400).json({
          error: "Entitas tidak ditemukan di master data maupun riwayat kunjungan.",
        });
      }
      if (resolvedEntity.segment !== segment) {
        return res.status(400).json({
          error: `Segmen yang dipilih (${segment}) tidak sesuai dengan segmen entitas (${resolvedEntity.segment}).`,
        });
      }
    } else {
      if (typeof region !== "string" || !region.trim()) {
        return res.status(400).json({
          error: "Wilayah kota wajib diisi.",
        });
      }
      const cleanName = entityName.trim();
      const cleanRegion = region.trim();
      const existingMatch = catalog.find(
        (item) =>
          item.name.trim().toLowerCase() === cleanName.toLowerCase() &&
          item.segment === segment &&
          item.region.trim().toLowerCase() === cleanRegion.toLowerCase()
      );
      resolvedEntity = existingMatch || {
        id: `ent-custom-${Date.now().toString(36)}`,
        name: cleanName,
        type:
          typeof entityType === "string" && entityType.trim()
            ? entityType.trim()
            : segment === "B2G"
            ? "Instansi Pemerintah"
            : "Perusahaan Swasta",
        segment,
        region: cleanRegion,
      };
    }

    const resolvedSalesName = isSuperAdmin(req.user)
      ? salesName !== undefined
        ? String(salesName).trim()
        : req.user.name
      : req.user.name;

    const matchedSalesUser = store.users.find(
      (u) => u.name.trim().toLowerCase() === resolvedSalesName.toLowerCase()
    );
    const resolvedUserId = isSuperAdmin(req.user)
      ? matchedSalesUser
        ? matchedSalesUser.id
        : req.user.id
      : req.user.id;

    const now = new Date().toISOString();
    const nextNumber = store.activities.length + 1;
    const newId = `act-${String(nextNumber).padStart(3, "0")}-${Date.now().toString().slice(-4)}`;

    const newActivity = {
      id: newId,
      userId: resolvedUserId,
      entityId: resolvedEntity.id,
      entityName: resolvedEntity.name,
      entityType: resolvedEntity.type,
      segment: resolvedEntity.segment,
      region: resolvedEntity.region,
      visitDate,
      status: "NOT_VISITED",
      salesName: resolvedSalesName,
      notes: typeof notes === "string" ? notes.trim() : "",
      createdAt: now,
      updatedAt: now,
      visitedAt: null,
    };

    store.activities.push(newActivity);
    if (!store.salesPeople.includes(resolvedSalesName)) {
      store.salesPeople.push(resolvedSalesName);
    }
    saveStore(store);

    return res.status(201).json(newActivity);
  });

  // Protected update activity status endpoint with RBAC ownership enforcement
  app.patch("/api/activities/:id", requireAuth, (req, res) => {
    const { id } = req.params;
    const { status, salesName, notes } = req.body || {};

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "Status wajib diisi dan harus bernilai VISITED atau NOT_VISITED.",
      });
    }

    if (salesName !== undefined && String(salesName).trim() === "") {
      return res.status(400).json({
        error: "Nama sales tidak boleh kosong.",
      });
    }

    const store = getStore();
    const activity = store.activities.find((item) => item.id === id);

    if (!activity) {
      return res.status(404).json({
        error: "Data rencana kunjungan tidak ditemukan.",
      });
    }

    if (!canAccessActivity(req.user, activity)) {
      return res.status(403).json({
        error: "Akses ditolak: Anda hanya dapat mengubah data kunjungan milik Anda sendiri.",
      });
    }

    if (
      !isSuperAdmin(req.user) &&
      salesName !== undefined &&
      String(salesName).trim().toLowerCase() !== req.user.name.trim().toLowerCase()
    ) {
      return res.status(403).json({
        error: "Akses ditolak: Anda tidak dapat mengalihkan kunjungan ke sales lain.",
      });
    }

    const now = new Date().toISOString();
    activity.status = status;
    activity.updatedAt = now;
    activity.visitedAt = status === "VISITED" ? now : null;

    if (isSuperAdmin(req.user) && salesName !== undefined) {
      const cleanedSales = String(salesName).trim();
      activity.salesName = cleanedSales;
      const matchedSalesUser = store.users.find(
        (u) => u.name.trim().toLowerCase() === cleanedSales.toLowerCase()
      );
      if (matchedSalesUser) {
        activity.userId = matchedSalesUser.id;
      }
      if (!store.salesPeople.includes(cleanedSales)) {
        store.salesPeople.push(cleanedSales);
      }
    }

    if (typeof notes === "string") {
      activity.notes = notes.trim();
    }

    saveStore(store);
    return res.json(activity);
  });

  return app;
}
